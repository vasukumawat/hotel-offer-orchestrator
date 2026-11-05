const num = (v: string | undefined, d: number): number =>
  v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;

export type MockMode = 'ok' | 'down' | 'slow';
const mode = (v: string | undefined): MockMode => (v === 'down' || v === 'slow' ? v : 'ok');

const port = num(process.env.PORT, 3000);

export const config = {
  port,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  orchestrator: (process.env.ORCHESTRATOR === 'local' ? 'local' : 'temporal') as 'temporal' | 'local',
  temporal: {
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'hotel-offers',
  },
  suppliers: {
    A: { url: process.env.SUPPLIER_A_URL ?? `http://localhost:${port}/supplierA/hotels` },
    B: { url: process.env.SUPPLIER_B_URL ?? `http://localhost:${port}/supplierB/hotels` },
  },
  supplierTimeoutMs: num(process.env.SUPPLIER_TIMEOUT_MS, 2000),
  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, 300),
  // Shorter TTL when a supplier was down, so we retry the missing supplier soon.
  degradedCacheTtlSeconds: num(process.env.DEGRADED_CACHE_TTL_SECONDS, 30),
  // Read per request by the mock router so they can be flipped at runtime in tests.
  mockMode: (id: 'A' | 'B'): MockMode => mode(process.env[`SUPPLIER_${id}_MODE`]),
};
