import express, { type NextFunction, type Request, type Response } from 'express';
import { AllSuppliersDownError, type Orchestrator } from './orchestrator';
import { mockSupplierRouter } from './suppliers/mock';
import type { CachedQuery, HotelOffer, OfferStore, SupplierId, SupplierStatus } from './types';

class BadRequest extends Error {}

function parsePrice(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${field} must be a non-negative number`);
  return n;
}

export function createApp(deps: { store: OfferStore; orchestrator: Orchestrator }) {
  const { store, orchestrator } = deps;
  const app = express();
  app.disable('x-powered-by');

  // Mock suppliers live in the same process: /supplierA/hotels and /supplierB/hotels.
  app.use(mockSupplierRouter());

  // Last supplier status seen from a live fetch; surfaced by /health.
  let lastSuppliers: Record<SupplierId, SupplierStatus> | null = null;

  app.get('/api/hotels', async (req, res, next) => {
    try {
      const cityRaw = req.query.city;
      if (typeof cityRaw !== 'string' || !cityRaw.trim()) throw new BadRequest('city is required');
      const city = cityRaw.trim().toLowerCase();
      const minPrice = parsePrice(req.query.minPrice, 'minPrice');
      const maxPrice = parsePrice(req.query.maxPrice, 'maxPrice');
      if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
        throw new BadRequest('minPrice must be <= maxPrice');
      }

      // 1) cache hit? (a Redis outage is treated as a miss, not a 500)
      let source: 'cache' | 'live' = 'cache';
      let result: CachedQuery | null = await store.query(city, minPrice, maxPrice).catch((e) => {
        console.warn('[cache] read failed:', (e as Error).message);
        return null;
      });

      // 2) miss -> orchestrate suppliers (workflow also writes the cache)
      if (!result) {
        source = 'live';
        const live = await orchestrator.fetchOffers(city);
        lastSuppliers = live.suppliers;
        if (live.cached) {
          result = await store.query(city, minPrice, maxPrice).catch(() => null);
        }
        result ??= {
          // cache unavailable: filter the fresh result in memory
          hotels: live.hotels.filter(
            (h: HotelOffer) => (minPrice === undefined || h.price >= minPrice) && (maxPrice === undefined || h.price <= maxPrice),
          ),
          meta: { suppliers: live.suppliers, degraded: live.degraded, fetchedAt: live.fetchedAt },
        };
      }

      // Names of suppliers that failed (also true for degraded results served from cache).
      const failed = (['A', 'B'] as const).filter((id) => result!.meta.suppliers[id] === 'failed');
      if (failed.length) res.setHeader('x-degraded-suppliers', failed.map((id) => `supplier${id}`).join(','));

      res.json({
        city,
        filters: { minPrice: minPrice ?? null, maxPrice: maxPrice ?? null },
        source,
        degraded: result.meta.degraded,
        suppliers: result.meta.suppliers,
        fetchedAt: result.meta.fetchedAt,
        count: result.hotels.length,
        hotels: result.hotels,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/health', async (_req, res) => {
    const [redisUp, temporal] = await Promise.all([store.ping(), orchestrator.health()]);
    const supplierIssue = lastSuppliers && (lastSuppliers.A === 'failed' || lastSuppliers.B === 'failed');
    const healthy = redisUp && temporal !== 'down';
    res.status(healthy ? 200 : 503).json({
      status: !healthy ? 'down' : supplierIssue ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      checks: { redis: redisUp ? 'up' : 'down', temporal },
      suppliers: lastSuppliers ?? 'unknown',
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof AllSuppliersDownError) return res.status(503).json({ error: err.message });
    console.error('[api] unhandled', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
