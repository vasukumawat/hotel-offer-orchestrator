import { fetchSupplierOffers as fetchFromSupplier } from '../suppliers/client';
import { RedisOfferStore } from '../cache';
import type { BuiltResult, HotelOffer, SupplierId } from '../types';

let store: RedisOfferStore | undefined;
const getStore = () => (store ??= RedisOfferStore.connect());

/** Activity: call one supplier. Throwing lets Temporal apply the retry policy. */
export async function fetchSupplierOffers(id: SupplierId, city: string): Promise<HotelOffer[]> {
  return fetchFromSupplier(id, city);
}

/** Activity: write the deduplicated list to Redis (ZSET + HASH). */
export async function cacheOffers(city: string, result: BuiltResult): Promise<void> {
  await getStore().store(city, result);
}
