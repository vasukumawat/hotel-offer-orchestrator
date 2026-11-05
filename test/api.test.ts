import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { LocalOrchestrator, SingleFlightOrchestrator } from '../src/orchestrator';
import type { BuiltResult, CachedQuery, OfferStore } from '../src/types';

// In-memory stand-in with the same semantics as the Redis store (inclusive bounds).
class MemoryStore implements OfferStore {
  data = new Map<string, BuiltResult>();
  async store(city: string, r: BuiltResult) { this.data.set(city, r); }
  async query(city: string, min = -Infinity, max = Infinity): Promise<CachedQuery | null> {
    const r = this.data.get(city);
    if (!r) return null;
    const { hotels, ...meta } = r;
    return { hotels: hotels.filter((h) => h.price >= min && h.price <= max), meta };
  }
  async ping() { return true; }
}

let server: Server;
let base: string;
let store: MemoryStore;

before(async () => {
  process.env.SUPPLIER_TIMEOUT_MS = '300';
  store = new MemoryStore();
  const orchestrator = new SingleFlightOrchestrator(new LocalOrchestrator(store));
  const app = createApp({ store, orchestrator });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  // point supplier client at this ephemeral server
  const { config } = await import('../src/config');
  config.suppliers.A.url = `${base}/supplierA/hotels`;
  config.suppliers.B.url = `${base}/supplierB/hotels`;
});
after(() => server.close());

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};

test('requires city', async () => {
  assert.equal((await get('/api/hotels')).status, 400);
});

test('rejects bad price params', async () => {
  assert.equal((await get('/api/hotels?city=delhi&minPrice=abc')).status, 400);
  assert.equal((await get('/api/hotels?city=delhi&minPrice=10&maxPrice=5')).status, 400);
});

test('dedupes across suppliers, then serves from cache with range filter', async () => {
  const live = await get('/api/hotels?city=delhi');
  assert.equal(live.status, 200);
  assert.equal(live.body.source, 'live');
  assert.equal(live.headers.get('x-degraded-suppliers'), null);
  assert.equal(live.body.count, 8); // 12 offers, 4 overlapping hotels merged
  const byName = Object.fromEntries(live.body.hotels.map((h: any) => [h.name.toLowerCase(), h]));
  assert.equal(byName['taj palace'].supplier, 'B');        // tie on price, higher commission
  assert.equal(byName['hotel royal plaza'].price, 4200);   // cheaper from B
  assert.equal(byName['itc maurya'].price, 13000);         // cheaper from A
  assert.equal(byName['the imperial'].supplier, 'A');      // full tie keeps A

  const ranged = await get('/api/hotels?city=delhi&minPrice=4000&maxPrice=12000');
  assert.equal(ranged.body.source, 'cache');
  assert.deepEqual(ranged.body.hotels.map((h: any) => h.price), [4200, 5200, 9000, 11500]);
});

test('degraded: supplier B down -> A results, degraded flag', async () => {
  process.env.SUPPLIER_B_MODE = 'down';
  const r = await get('/api/hotels?city=mumbai');
  assert.equal(r.status, 200);
  assert.equal(r.body.degraded, true);
  assert.deepEqual(r.body.suppliers, { A: 'ok', B: 'failed' });
  assert.equal(r.body.count, 3);
  assert.equal(r.headers.get('x-degraded-suppliers'), 'supplierB');
  // degraded result served from cache keeps the header
  const again = await get('/api/hotels?city=mumbai&minPrice=7000');
  assert.equal(again.body.source, 'cache');
  assert.equal(again.headers.get('x-degraded-suppliers'), 'supplierB');
  delete process.env.SUPPLIER_B_MODE;
});

test('degraded: supplier A slow (timeout) -> B results', async () => {
  process.env.SUPPLIER_A_MODE = 'slow';
  const r = await get('/api/hotels?city=bangalore');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.suppliers, { A: 'failed', B: 'ok' });
  assert.equal(r.body.hotels[0].supplier, 'B');
  assert.equal(r.headers.get('x-degraded-suppliers'), 'supplierA');
  delete process.env.SUPPLIER_A_MODE;
});

test('both suppliers down -> 503 and nothing cached', async () => {
  process.env.SUPPLIER_A_MODE = 'down';
  process.env.SUPPLIER_B_MODE = 'down';
  const r = await get('/api/hotels?city=pune');
  assert.equal(r.status, 503);
  assert.equal(store.data.has('pune'), false);
  delete process.env.SUPPLIER_A_MODE;
  delete process.env.SUPPLIER_B_MODE;
});

test('/health', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.checks.redis, 'up');
});
