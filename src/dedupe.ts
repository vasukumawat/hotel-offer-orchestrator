import type { BuiltResult, HotelOffer, SupplierId } from './types';

/** Canonical identity for a hotel: case/accent/punctuation/whitespace-insensitive. */
export function hotelKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isBetter = (candidate: HotelOffer, current: HotelOffer): boolean =>
  candidate.price < current.price ||
  (candidate.price === current.price && candidate.commission > current.commission);

/**
 * Dedupe by hotel name: keep the cheapest offer; on equal price the higher
 * commission wins; on a full tie the earlier offer (supplier A) is kept.
 * Result is sorted by price ascending (then name) for deterministic output.
 */
export function dedupeOffers(offers: HotelOffer[]): HotelOffer[] {
  const best = new Map<string, HotelOffer>();
  for (const offer of offers) {
    const key = hotelKey(offer.name);
    if (!key) continue;
    const current = best.get(key);
    if (!current || isBetter(offer, current)) best.set(key, offer);
  }
  return [...best.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

/** `null` means that supplier failed. */
export function buildResult(a: HotelOffer[] | null, b: HotelOffer[] | null): BuiltResult {
  const suppliers: Record<SupplierId, 'ok' | 'failed'> = {
    A: a ? 'ok' : 'failed',
    B: b ? 'ok' : 'failed',
  };
  return {
    hotels: dedupeOffers([...(a ?? []), ...(b ?? [])]),
    suppliers,
    degraded: !a || !b,
    fetchedAt: new Date().toISOString(),
  };
}
