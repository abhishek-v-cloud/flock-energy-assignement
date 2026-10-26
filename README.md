# Urja Meter API

A clean, documented REST API in front of **Urja Meter Ops**, a legacy smart-meter portal that has no API. With it, another engineer or a program can list and look up meters, see where each one sits in the distribution network, and read its consumption, all without touching the portal.

Node.js 22 + Express 5. There are two runtime dependencies (`express`, `swagger-ui-express`) and no database.

| Deliverable | Where |
|---|---|
| How the portal works (auth, endpoints, quirks, data problems) | **[PROTOCOL.md](PROTOCOL.md)** |
| OpenAPI 3.1 description of *this* API | **[openapi.json](openapi.json)**, browsable at `http://localhost:3000/docs` |
| Reflection questions | **[REFLECTION.md](REFLECTION.md)** |

---

## Quick start

```bash
git clone <this repo> && cd flock-energy-api
npm install
cp .env.example .env      # then set PORTAL_EMAIL / PORTAL_PASSWORD (from the brief)
npm start                 # → http://localhost:3000
```

The brief's credentials are `operator@urja.local` / `urja-ops-2026`. They are not committed to the repo; put them in `.env`.

Then open `http://localhost:3000/docs` for the interactive API docs (Swagger UI).

You need Node **22 or newer**. Run the tests with `npm test`; they use a local fake portal, need no network, and take about 0.5 s.

### Configuration
Everything is set through environment variables, or `.env` (read with Node's built-in loader). Only the credentials are required.

| Variable | Default | Meaning |
|---|---|---|
| `PORTAL_BASE_URL` | `https://urja-ops.flockenergy.tech` | Portal to wrap |
| `PORTAL_EMAIL` / `PORTAL_PASSWORD` | (none, required) | Portal login |
| `PORT` | `3000` | HTTP port |
| `PORTAL_RATE_LIMIT_PER_MINUTE` | `100` | Our self-imposed pace (the portal allows 120/min per session) |
| `PORTAL_MAX_WAIT_MS` | `30000` | How long one request may wait out rate limiting before we return 503 |
| `PORTAL_TIMEOUT_MS` | `15000` | Per-request timeout to the portal |
| `CATALOGUE_TTL_SECONDS` | `900` | Age at which meter data is refreshed in the background |
| `CATALOGUE_MAX_STALE_SECONDS` | `86400` | Oldest catalogue we'll serve if refreshes keep failing |
| `CONSUMPTION_TTL_SECONDS` | `300` | Cache time for consumption windows that may still change |
| `CONSUMPTION_MAX_ENTRIES` | `500` | Most consumption windows kept in the cache (least recently used evicted first) |

---

## Endpoints

| Method & path | What it does |
|---|---|
| `GET /api/v1/meters` | List meters. Filter by `q` (id/serial), `status`, `make`, `phase`, or any network level (`zone` … `transformer`). Paginated with `page`/`pageSize`. |
| `GET /api/v1/meters/{meterId}` | One meter: attributes, full network path, location, any data repairs applied |
| `GET /api/v1/meters/{meterId}/consumption` | Energy per interval from register readings, with `from`/`to` (IST days) |
| `GET /api/v1/hierarchy?depth=` | The zone → circle → division → subdivision → substation → feeder → transformer tree, with meter and status counts |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the OpenAPI document |

There is no login endpoint: the service logs in to the portal itself and manages the session (see design decisions).

Conventions:
- Lists return `{ data, pagination, meta }`; single items return `{ data, meta }`.
- `meta` always says where the data came from and how old it is.
- Every error has the same shape: `{ "error": { "code", "message", "details?" } }`.
- Bad dates, statuses and page numbers are **rejected with 400**, not silently ignored as the portal does.
- Enum values are lower snake case (`whole_current`). Timestamps are ISO 8601 with an explicit `+05:30` offset.

## Sample request

```bash
curl "http://localhost:3000/api/v1/meters/J100089/consumption?from=2026-06-28&to=2026-06-29"
```
```jsonc
{
  "data": {
    "meterId": "J100089",
    "requestedWindow": { "from": "2026-06-28", "to": "2026-06-29" },
    "totalKwh": 15.29,
    "totalKvah": 16.51,
    "series": [                          // this meter reports once a day (others every 30 min)
      { "start": "2026-06-28T00:00:00+05:30", "end": "2026-06-29T00:00:00+05:30", "kwh": 7.65, "kvah": 8.25, "voltageR": 232 },
      { "start": "2026-06-29T00:00:00+05:30", "end": "2026-06-30T00:00:00+05:30", "kwh": 7.64, "kvah": 8.26, "voltageR": 229 }
    ],
    "notes": ["1 duplicate reading(s) collapsed (kept the most complete row)."]
  },
  "meta": { "source": "portal", "fetchedAt": "2026-10-25T18:37:51.365Z", "cacheExpiresAt": "2026-10-26T18:37:51.365Z" }
}
```

More examples:
```bash
# Faulty three-phase meters in zone Z-01
curl "localhost:3000/api/v1/meters?status=faulty&phase=three&zone=Z-01"
# One meter (J100011's blank circle code was repaired; see its dataQuality list)
curl "localhost:3000/api/v1/meters/J100011"
# The top two levels of the network tree
curl "localhost:3000/api/v1/hierarchy?depth=2"
```

---

## How it's structured

```
src/
  server.js            wiring + startup (warms the catalogue)
  app.js               Express app: routes, /docs, error → HTTP mapping
  config.js            env-driven configuration
  service.js           use cases: one method per endpoint
  api/
    routes.js          thin HTTP handlers
    validation.js      query parsing → 400 with per-parameter details
  portal/              ← the only code that knows how the portal speaks HTTP
    client.js          login, session, re-auth, pacing, 429 back-off, retries, signed export
    signing.js         the export's HMAC signature
    errors.js          typed errors the API layer maps to 404/502/503
  domain/              ← pure functions, no I/O
    meters.js          export records → clean model; hierarchy repair
    hierarchy.js       tree from per-meter paths + per-level consistency
    consumption.js     register readings → energy per interval
    catalogue.js       cached, indexed snapshot of all meters (stale-while-revalidate)
    query.js           filtering, pagination
  util/                TTL/LRU cache, sliding-window rate limiter
test/                  node:test: unit tests + end-to-end against a fake portal
```

Requests flow `routes → service → (catalogue | portal client) → domain`. The portal adapter returns the portal's own payloads unchanged; turning them into our model happens only in `domain/`. If the portal changes, the change is contained in `portal/` and `fromExportRecord` in `meters.js`.

### Where the data comes from

| Data | Source | Cost |
|---|---|---|
| Meters, network paths, coordinates | Signed bulk export `/portal/export` (+ `/portal/keys`) | 2 requests for **all** 403 meters |
| Transformer names (to fix stale DT names) | `/portal/dts` (2 pages) | 2 requests |
| Consumption | `/portal/meters/{id}/energy` live, per request | 1 request |

---

## Design decisions and trade-offs

**Manage the portal session inside the service, rather than exposing a login endpoint.** The reference allowed either. Callers shouldn't need portal credentials or deal with a 1-hour session, so the service logs in on first use and re-logs in as needed.

**Use the bulk export rather than scraping pages.** The portal's pages would take 403 × 2 requests (detail + geo) to cover the fleet. At the portal's 120 requests/min that is about 7 minutes per refresh. The export has the same data in one call, so a full catalogue refresh costs 4 requests and finishes in under a second. The cost is a dependency on the HMAC signature scheme, which is the most fragile thing I rely on. If the signature is rejected, the client re-fetches the secret once; if the export keeps failing, the last good catalogue is served for up to 24 h.

**Keep the catalogue in memory, refresh it with stale-while-revalidate, and fetch consumption live.** Meter master data changes slowly, and every list, filter and hierarchy query needs all of it. So it is held in memory and refreshed in the background after 15 minutes. Callers never wait for a refresh unless the data is more than 24 h old, and `meta.stale` shows its age. Consumption is per-meter and only one portal call, so it's fetched on demand and cached:
- 5 minutes for windows that could still change;
- 24 h for windows that closed more than a day ago. Readings for past intervals don't change; I kept 24 h rather than "forever" to allow for late backfill.

**Return consumption as energy per interval, not raw registers.** The portal hands back cumulative counter values as strings, and nobody can use those directly. We convert them to numbers, take differences between consecutive readings, and label each interval by its start. Specifically:
- **Asking for a window fetches one extra day**, so the last day has its closing reading. Without it, the last day of every query would be missing.
- 40 meters report every 30 minutes and 363 report daily. Because each interval carries its own `start`/`end`, both kinds come out correctly without special-casing.
- Duplicate rows are collapsed, keeping the most complete one. A missing reading, or a register that goes backwards, gives `null` energy for that interval rather than a wrong or negative number.
- Caveats are returned in `notes`, including "decommissioned but still consuming".

**Repair the hierarchy visibly, and don't invent a tree.** The portal's hierarchy isn't a tree: mid-level nodes appear under several parents with no majority (see PROTOCOL §5). I didn't pick parents arbitrarily. Instead:
- blank codes/names are filled from the fleet-wide 1:1 code↔name mapping;
- DT names are taken from the transformer register;
- every change is recorded on the meter's `dataQuality` list.

`/hierarchy` shows paths exactly as meters report them, and its `consistency` block says, per level, how many nodes appear under more than one parent.

**Be a good citizen of the portal.** The client paces itself at 100 requests per 60 s (below the portal's 120), with requests queued first-in-first-out. On a 429 it backs off exponentially (2 s, 4 s, 8 s, …) within a 30 s budget, then returns 503 + `Retry-After` to our caller. Other protections:
- One login is shared by concurrent requests.
- The client re-logs in 60 s before the 1 h session ends, and also on a 401.
- Network errors and 5xx responses are retried twice.

I deliberately did **not** rotate sessions to get more throughput, even though the limit is per session. That would be getting around a control the portal operator chose.

**Validate the inputs that matter.** The portal silently ignores bad parameters (a malformed date just gives you its default week). Here an invalid date, status, page number or `depth` is a 400 that names the offending parameter. Unknown parameters are ignored, as most APIs do.

**Hand-written OpenAPI.** `openapi.json` is edited by hand; with four endpoints a generator would add more than it saves. It lints clean with Redocly. A test checks that every documented path is actually routed.

**Small dependency footprint.** Native `fetch`, `node:test`, `process.loadEnvFile`. No axios, cookie jar, dotenv, HTML parser, test framework or ORM. There is only one cookie to manage, and every page is fed by JSON endpoints.

## Assumptions

- **Portal timestamps are India Standard Time (UTC+05:30).** The portal sends no zone. The utility, the coordinates and the place names are all in Jaipur, and India has no DST. If this is wrong, it is one constant in `consumption.js`.
- **`kwh`/`kvah` are cumulative registers.** They only ever increase, and the deltas are plausible (≈0.4 kWh per half-hour, ≈8 kWh per day). Consumption is computed from differences between readings.
- **Interval labels:** a reading at time T is the register at T. The interval from T to the next reading is labelled by its start, so "1 June" means 1 June 00:00 → 2 June 00:00.
- **The transformer register (`/portal/dts`) wins over meter records on DT names.** It is the dedicated list of assets; the 3 conflicting meters look like later additions carrying a legacy name.
- **Blank hierarchy fields mean missing data, not a different node.** The code↔name mapping is perfectly 1:1 wherever both are present.
- **This API is internal and read-only**, so it has no auth of its own (see below).
- The portal is a **read-only** source; nothing here writes to it.

## Intentionally skipped

- **A login endpoint** (`POST /auth/login`). The session is managed behind the scenes instead (see above).
- **Authentication on this API.** It would be needed before exposing the service beyond a trusted network, but it adds nothing to show here. The obvious next step is an API key or the company's SSO at a gateway.
- **Endpoints beyond the core four** (transformers, fleet summaries, a data-quality report, health checks). Kept out to keep the API to what was asked; the data for them is already in the catalogue.
- **A web client.** The API and its Swagger UI are the deliverable.
- **A database or persistent cache.** 403 meters fit in memory a thousand times over, and a cold start costs 4 portal calls and under a second (see Scaling).
- **A fleet-wide consumption index** (e.g. "top consumers"). Answering needs 403 energy calls, about 4 minutes at the rate limit. It belongs in a scheduled background job, not in a request.
- **Multiple portal sessions to raise throughput.** Technically easy; not the right call without the operator's agreement.
- **TypeScript and a build step.** For a service this size, I preferred `npm start` running with no build.

## Scaling: where this approach would start to struggle

Everything is a linear scan over an in-memory array, rebuilt from one bulk call.
- **About 50k meters:** filtering is still single-digit milliseconds, but the export payload (≈0.6 KB per meter → ~30 MB) and rebuilding the snapshot every 15 minutes start to matter. Fix: incremental refresh (if the portal offered `updatedSince`), or index meters by status/zone/DT in `Map`s instead of scanning.
- **About 500k meters, or several API instances:** the snapshot no longer belongs in each process's memory. Move it to Postgres + PostGIS: real indexes for filters, a GiST index for location queries, and one refresher process instead of every instance hitting the portal.
- **Consumption:** live fetches cap total throughput at about 100 requests/min per session. A real data team would want an ingestion job writing readings to a time-series store, with the API reading from that store.

## With more time

1. **Background consumption ingestion** for all meters, paced under the rate limit, to answer fleet-wide questions (top consumers, decommissioned-but-consuming meters).
2. **Contract tests against the live portal** (opt-in, run nightly) to catch protocol drift in the signature scheme or field names.
3. **Structured logs and metrics** (portal latency, 429s, re-logins, cache hit rate).
4. **ETag / `Cache-Control`** on responses, derived from the catalogue's `fetchedAt`.
5. **Hierarchy:** ask the utility which source is authoritative for the mid-level network. The data alone can't settle it.

## Testing

`npm test` runs 38 tests in about 0.5 s with no network:
- **Unit tests** cover timestamp/IST handling, register deltas, windowing, duplicate rows, backwards registers, hierarchy repair, multi-parent consistency and filters.
- **Client tests** run against a **fake portal** ([test/fakePortal.js](test/fakePortal.js)) that reproduces the real protocol: Better Auth login with an Origin check, cookie sessions, the HMAC export, 401 session expiry, 429s, and a rotating secret.
- **End-to-end API tests** run the real app against the same fake portal: filters, validation errors, 404s, caching, error→status mapping (503 + `Retry-After`), and that `openapi.json` matches the routes.

## Reflection

See **[REFLECTION.md](REFLECTION.md)**.
