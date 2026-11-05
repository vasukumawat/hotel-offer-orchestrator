// Workflow code runs in a deterministic sandbox: only import pure modules + types here.
import { proxyActivities } from '@temporalio/workflow';
import { buildResult } from '../dedupe';
import type * as activities from './activities';
import type { OffersResult } from '../types';

const { fetchSupplierOffers, cacheOffers } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds',
  retry: { maximumAttempts: 2, initialInterval: '200 milliseconds', backoffCoefficient: 2 },
});

export async function fetchHotelOffersWorkflow(city: string): Promise<OffersResult> {
  // Fan out in parallel; a supplier that exhausts its retries must not fail the whole request.
  const [a, b] = await Promise.allSettled([
    fetchSupplierOffers('A', city),
    fetchSupplierOffers('B', city),
  ]);

  const built = buildResult(
    a.status === 'fulfilled' ? a.value : null,
    b.status === 'fulfilled' ? b.value : null,
  );

  // Never cache an "everything failed" result.
  if (built.suppliers.A === 'failed' && built.suppliers.B === 'failed') {
    return { ...built, cached: false };
  }

  let cached = false;
  try {
    await cacheOffers(city, built);
    cached = true;
  } catch {
    // Cache outage is non-fatal: the API falls back to filtering in memory.
  }
  return { ...built, cached };
}
