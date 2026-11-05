import { Router } from 'express';
import { config } from '../config';

/** Mock supplier A: { hotels: [{ hotelId, name, price, commissionPct }] } */
const A: Record<string, Array<[string, number, number]>> = {
  delhi: [
    ['Taj Palace', 11500, 12],
    ['Hotel Royal Plaza', 4500, 10],
    ['The Imperial', 14000, 15],
    ['Lemon Tree Premier', 5200, 8],
    ['Zostel Delhi', 1200, 5],
    ['ITC Maurya', 13000, 11],
  ],
  mumbai: [
    ['Taj Mahal Palace', 18000, 14],
    ['Trident Nariman Point', 9500, 10],
    ['Sea Princess', 7000, 9],
  ],
  bangalore: [
    ['The Oberoi', 15000, 13],
    ['Lemon Tree Premier', 5600, 8],
  ],
};

/** Mock supplier B: { results: [{ id, hotel_name, total_price, commission }] } */
const B: Record<string, Array<[string, number, number]>> = {
  delhi: [
    ['taj palace', 11500, 15], // same price as A, higher commission -> B wins
    ['Hotel  Royal Plaza', 4200, 9], // cheaper than A -> B wins
    ['ITC Maurya', 13500, 12], // more expensive than A -> A wins
    ['Bloomrooms Janpath', 3800, 10],
    ['The Imperial', 14000, 15], // full tie -> A kept
    ['Radisson Blu Plaza', 9000, 10],
  ],
  mumbai: [
    ['Taj Mahal Palace', 17500, 12],
    ['Hotel Marine Plaza', 8200, 10],
  ],
  bangalore: [['The Oberoi', 15000, 16]],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockSupplierRouter(): Router {
  const r = Router();

  const guard = (id: 'A' | 'B') => async (_req: any, res: any, next: any) => {
    const mode = config.mockMode(id);
    if (mode === 'down') return res.status(503).json({ error: `Supplier ${id} unavailable` });
    if (mode === 'slow') await sleep(config.supplierTimeoutMs * 3);
    next();
  };

  r.get('/supplierA/hotels', guard('A'), (req, res) => {
    const city = String(req.query.city ?? '').trim().toLowerCase();
    res.json({
      hotels: (A[city] ?? []).map(([name, price, commissionPct], i) => ({
        hotelId: `A-${city}-${i + 1}`,
        name,
        city,
        price,
        currency: 'INR',
        commissionPct,
      })),
    });
  });

  r.get('/supplierB/hotels', guard('B'), (req, res) => {
    const city = String(req.query.city ?? '').trim().toLowerCase();
    res.json({
      results: (B[city] ?? []).map(([hotel_name, total_price, commission], i) => ({
        id: `B-${city}-${i + 1}`,
        hotel_name,
        city,
        total_price,
        currency: 'INR',
        commission,
      })),
    });
  });

  return r;
}
