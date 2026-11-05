import Redis from 'ioredis';
import { config } from './config';
import { hotelKey } from './dedupe';
import type { BuiltResult, CachedQuery, HotelOffer, OfferStore } from './types';

/**
 * Per-city layout:
 *   hotels:{city}:prices  ZSET   member = hotelKey, score = price      (range queries)
 *   hotels:{city}:data    HASH   field  = hotelKey, value = offer JSON (payloads)
 *   hotels:{city}:meta    STRING supplier status / fetchedAt           (also the "is cached" marker)
 */
export class RedisOfferStore implements OfferStore {
  constructor(private readonly redis: Redis) {}

  static connect(url = config.redisUrl): RedisOfferStore {
    const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on('error', () => {}); // surfaced per-command; avoid unhandled 'error' events
    return new RedisOfferStore(redis);
  }

  private keys(city: string) {
    const c = city.trim().toLowerCase();
    return { prices: `hotels:${c}:prices`, data: `hotels:${c}:data`, meta: `hotels:${c}:meta` };
  }

  async store(city: string, result: BuiltResult): Promise<void> {
    const k = this.keys(city);
    const ttl = result.degraded ? config.degradedCacheTtlSeconds : config.cacheTtlSeconds;
    const meta = JSON.stringify({
      suppliers: result.suppliers,
      degraded: result.degraded,
      fetchedAt: result.fetchedAt,
    });

    // MULTI/EXEC: readers never observe a half-written (or half-deleted) city.
    const tx = this.redis.multi().del(k.prices, k.data);
    if (result.hotels.length) {
      const zargs: Array<string | number> = [];
      const hash: Record<string, string> = {};
      for (const h of result.hotels) {
        const key = hotelKey(h.name);
        zargs.push(h.price, key);
        hash[key] = JSON.stringify(h);
      }
      tx.zadd(k.prices, ...zargs).hset(k.data, hash).expire(k.prices, ttl).expire(k.data, ttl);
    }
    tx.set(k.meta, meta, 'EX', ttl);

    const out = await tx.exec();
    const failed = out?.find(([err]) => err);
    if (!out || failed) throw failed?.[0] ?? new Error('Redis transaction aborted');
  }

  async query(city: string, minPrice?: number, maxPrice?: number): Promise<CachedQuery | null> {
    const k = this.keys(city);
    const rawMeta = await this.redis.get(k.meta);
    if (!rawMeta) return null;

    const keys = await this.redis.zrangebyscore(
      k.prices,
      minPrice ?? '-inf',
      maxPrice ?? '+inf', // inclusive on both ends
    );
    const rows = keys.length ? await this.redis.hmget(k.data, ...keys) : [];
    // A null row means the hash expired between the two calls; just skip it.
    const hotels = rows.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as HotelOffer);
    return { hotels, meta: JSON.parse(rawMeta) };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
