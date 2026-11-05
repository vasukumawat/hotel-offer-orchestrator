export type SupplierId = 'A' | 'B';
export type SupplierStatus = 'ok' | 'failed';

export interface HotelOffer {
  name: string;
  city: string;
  price: number;
  currency: string;
  /** Commission percentage the supplier pays us. */
  commission: number;
  supplier: SupplierId;
  supplierHotelId?: string;
}

/** Output of supplier fan-out + dedupe (what gets cached). */
export interface BuiltResult {
  hotels: HotelOffer[];
  suppliers: Record<SupplierId, SupplierStatus>;
  degraded: boolean;
  fetchedAt: string;
}

/** Output of the orchestration (workflow / local runner). */
export interface OffersResult extends BuiltResult {
  /** Whether the cache write succeeded. */
  cached: boolean;
}

export interface CachedQuery {
  hotels: HotelOffer[];
  meta: Pick<BuiltResult, 'suppliers' | 'degraded' | 'fetchedAt'>;
}

export interface OfferStore {
  store(city: string, result: BuiltResult): Promise<void>;
  /** null = cache miss. Price bounds are inclusive. */
  query(city: string, minPrice?: number, maxPrice?: number): Promise<CachedQuery | null>;
  ping(): Promise<boolean>;
}
