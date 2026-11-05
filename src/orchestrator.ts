import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { config } from './config';
import { buildResult } from './dedupe';
import { fetchSupplierOffers } from './suppliers/client';
import type { OfferStore, OffersResult } from './types';

export class AllSuppliersDownError extends Error {
  constructor() {
    super('All suppliers are unavailable');
  }
}

export interface Orchestrator {
  /** Fan out to both suppliers, dedupe, cache. Throws AllSuppliersDownError if both fail. */
  fetchOffers(city: string): Promise<OffersResult>;
  health(): Promise<'up' | 'down' | 'disabled'>;
  close(): Promise<void>;
}

function assertAnySupplier(r: OffersResult): OffersResult {
  if (r.suppliers.A === 'failed' && r.suppliers.B === 'failed') throw new AllSuppliersDownError();
  return r;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 200): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
    }
  }
  throw lastErr;
}

/** Same behaviour as the Temporal workflow, without needing a Temporal server (dev / tests). */
export class LocalOrchestrator implements Orchestrator {
  constructor(private readonly store: OfferStore) {}

  async fetchOffers(city: string): Promise<OffersResult> {
    const [a, b] = await Promise.allSettled([
      withRetry(() => fetchSupplierOffers('A', city)),
      withRetry(() => fetchSupplierOffers('B', city)),
    ]);
    const built = buildResult(
      a.status === 'fulfilled' ? a.value : null,
      b.status === 'fulfilled' ? b.value : null,
    );
    if (built.degraded && built.suppliers.A === built.suppliers.B) {
      return assertAnySupplier({ ...built, cached: false });
    }
    let cached = false;
    try {
      await this.store.store(city, built);
      cached = true;
    } catch (e) {
      console.warn('[cache] write failed:', (e as Error).message);
    }
    return { ...built, cached };
  }

  async health() {
    return 'disabled' as const;
  }
  async close() {}
}

export class TemporalOrchestrator implements Orchestrator {
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<TemporalOrchestrator> {
    const connection = await Connection.connect({ address: config.temporal.address });
    return new TemporalOrchestrator(new Client({ connection, namespace: config.temporal.namespace }));
  }

  async fetchOffers(city: string): Promise<OffersResult> {
    const result = (await this.client.workflow.execute('fetchHotelOffersWorkflow', {
      taskQueue: config.temporal.taskQueue,
      workflowId: `hotel-offers-${city}-${randomUUID()}`,
      args: [city],
      workflowExecutionTimeout: '20 seconds',
    })) as OffersResult;
    return assertAnySupplier(result);
  }

  async health() {
    try {
      await Promise.race([
        this.client.connection.workflowService.getSystemInfo({}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
      ]);
      return 'up' as const;
    } catch {
      return 'down' as const;
    }
  }

  async close() {
    await this.client.connection.close();
  }
}

/** Collapses concurrent cache misses for the same city into one workflow run (stampede guard). */
export class SingleFlightOrchestrator implements Orchestrator {
  private inflight = new Map<string, Promise<OffersResult>>();
  constructor(private readonly inner: Orchestrator) {}

  fetchOffers(city: string): Promise<OffersResult> {
    const key = city.trim().toLowerCase();
    let p = this.inflight.get(key);
    if (!p) {
      p = this.inner.fetchOffers(key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
  health() {
    return this.inner.health();
  }
  close() {
    return this.inner.close();
  }
}
