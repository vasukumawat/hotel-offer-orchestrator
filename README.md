# Hotel Offer Orchestrator

Node.js / TypeScript service that queries two mock hotel suppliers in parallel, dedupes by hotel name
(cheapest wins, higher commission breaks ties), caches the result in Redis (ZSET + HASH) and serves
price-range filtered results straight from Redis. Orchestration runs as a **Temporal workflow**.

## Run it

```bash
docker compose up --build
# API :3000   Temporal UI :8233
```

Without Docker (needs Redis; Temporal optional):

```bash
npm install
# Option 1: full stack (Temporal server on :7233, e.g. `temporal server start-dev`)
npm run dev:worker &   # Temporal worker
npm run dev:api
# Option 2: no Temporal – same orchestration logic in-process
ORCHESTRATOR=local npm run dev:api
```

Tests: `npm test` (dedupe rules + HTTP behaviour incl. degraded/timeout/both-down; no Redis needed).

## API

| Endpoint | Description |
|---|---|
| `GET /api/hotels?city=delhi` | Fan out to both suppliers, dedupe, cache, return all hotels (sorted by price) |
| `GET /api/hotels?city=delhi&minPrice=4000&maxPrice=12000` | Price-range filter (inclusive), answered from Redis `ZRANGEBYSCORE` |
| `GET /supplierA/hotels?city=` · `GET /supplierB/hotels?city=` | Mock suppliers (different payload shapes). Cities: `delhi`, `mumbai`, `bangalore` |
| `GET /health` | Redis + Temporal connectivity, last-seen supplier status. `200 ok/degraded`, `503 down` |

Response:

```json
{ "city": "delhi", "filters": {"minPrice": 4000, "maxPrice": 12000}, "source": "cache|live",
  "degraded": false, "suppliers": {"A": "ok", "B": "ok"}, "fetchedAt": "...", "count": 4,
  "hotels": [{ "name": "Hotel Royal Plaza", "price": 4200, "currency": "INR", "commission": 9, "supplier": "B", ... }] }
```

Errors: `400` missing city / invalid or inverted price range, `503` both suppliers down.

## Behaviour

- **Dedupe**: hotels are matched on a normalised name (case, accents, punctuation, extra spaces ignored,
  so `taj palace` == `Taj Palace`). Lowest price wins; equal price → higher commission; full tie → Supplier A.
- **Resilience**: each supplier call has a timeout and 2 attempts (Temporal activity retry policy).
  A supplier that still fails is dropped; the response is `200` with partial data, `degraded: true` and the
  header `x-degraded-suppliers: supplierB` (also set when a degraded result is served from cache).
  Both down → `503`, and nothing is cached.
- **Failure simulation**: set `SUPPLIER_A_MODE` / `SUPPLIER_B_MODE` to `down` or `slow` (see `docker-compose.yml`).

## Redis layout (per city)

| Key | Type | Content |
|---|---|---|
| `hotels:{city}:prices` | ZSET | member = normalised hotel name, score = price |
| `hotels:{city}:data` | HASH | field = normalised hotel name, value = offer JSON |
| `hotels:{city}:meta` | STRING | supplier status, `degraded`, `fetchedAt`; doubles as the "cached" marker |

Written with `MULTI/EXEC` so readers never see a half-built city. TTL is 300 s, or 30 s when degraded so the
missing supplier is retried quickly (`CACHE_TTL_SECONDS`, `DEGRADED_CACHE_TTL_SECONDS`).

## Design

```
GET /api/hotels ──► Redis hit? ──yes──► ZRANGEBYSCORE + HMGET ──► response
                       │ no
                       ▼
              Temporal workflow fetchHotelOffersWorkflow(city)
                 ├─ activity fetchSupplierOffers(A)  ┐ parallel, retried
                 ├─ activity fetchSupplierOffers(B)  ┘ allSettled → partial OK
                 ├─ dedupe (pure, deterministic)
                 └─ activity cacheOffers → Redis
```

- `src/dedupe.ts` is pure and shared by the workflow and the local runner.
- Concurrent cache misses for one city are collapsed into a single workflow run (`SingleFlightOrchestrator`).
- A Redis outage is not fatal: reads are treated as misses and the fresh result is filtered in memory
  (`/health` reports `503` so it is still visible).
- Assumption: all suppliers quote the same currency (INR in the mocks); no FX conversion.

## Layout

```
src/app.ts            routes, validation, /health, degraded header
src/orchestrator.ts   Temporal client orchestrator, local fallback, single-flight
src/temporal/         workflows.ts, activities.ts, worker.ts
src/cache.ts          Redis ZSET + HASH store
src/suppliers/        mock endpoints + supplier client/normalisation
src/dedupe.ts         dedupe + result building
test/                 unit + HTTP tests
```
