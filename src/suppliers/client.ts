import { config } from '../config';
import type { HotelOffer, SupplierId } from '../types';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Each supplier has its own payload shape; normalise to HotelOffer and drop malformed rows. */
export function normalizeSupplier(id: SupplierId, body: any, city: string): HotelOffer[] {
  const rows: any[] = id === 'A' ? body?.hotels : body?.results;
  if (!Array.isArray(rows)) throw new Error(`Supplier ${id} returned an unexpected payload`);

  const offers: HotelOffer[] = [];
  for (const row of rows) {
    const name = id === 'A' ? row?.name : row?.hotel_name;
    const price = id === 'A' ? row?.price : row?.total_price;
    const commission = id === 'A' ? row?.commissionPct : row?.commission;
    if (typeof name !== 'string' || !name.trim() || !isNum(price) || price < 0) continue;
    offers.push({
      name: name.trim().replace(/\s+/g, ' '),
      city,
      price,
      currency: typeof row.currency === 'string' ? row.currency : 'INR',
      commission: isNum(commission) ? commission : 0,
      supplier: id,
      supplierHotelId: String((id === 'A' ? row.hotelId : row.id) ?? ''),
    });
  }
  return offers;
}

/** Throws on timeout / non-2xx / bad payload so callers (Temporal activity or local retry) can retry. */
export async function fetchSupplierOffers(id: SupplierId, city: string): Promise<HotelOffer[]> {
  const url = `${config.suppliers[id].url}?city=${encodeURIComponent(city)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.supplierTimeoutMs) });
  if (!res.ok) throw new Error(`Supplier ${id} responded with HTTP ${res.status}`);
  return normalizeSupplier(id, await res.json(), city);
}
