# How the Urja Meter Ops portal works

These are notes on the portal at `https://urja-ops.flockenergy.tech`, worked out from the outside: browser-equivalent HTTP requests with `curl`, plus reading the portal's own client-side JavaScript. Every claim here was checked against the live portal (October 2026). Where something is inferred and not proven, it says so.

## 1. What it is built on

- A **SvelteKit** app (`X-Sveltekit-Page: true` response header, `/_app/immutable/...` bundles, `__sveltekit_*` boot script) using **Svelte 5**.
- Authentication is **Better Auth**. Its session cookie is `__Secure-better-auth.session_token`, and its standard endpoints are mounted at `/api/auth/*`.
- Pages are server-rendered **without their data**. For example, the meter list SSRs as "0 total" and is then filled in by browser `fetch` calls to JSON endpoints under `/portal/*`. Those endpoints are the "hidden API".
- The route manifest is in `/_app/immutable/entry/app.*.js`. It lists every page, so it tells you there is nothing else to find: `/login`, `/meters`, `/meters/[id]` and `/transformers`, plus the root, which redirects.

I found the endpoints by downloading each page's JS chunk (`/_app/immutable/nodes/N.*.js`) and searching it for `fetch(`.

## 2. Authentication

| | |
|---|---|
| Login (what the form does) | `POST /login` (a SvelteKit form action) with form fields `email`, `password` |
| Login (what we use) | `POST /api/auth/sign-in/email` with JSON `{"email","password"}`: Better Auth's endpoint, same backend |
| CSRF | Both **require an `Origin` header** matching the site. Without it you get `403 Cross-site POST form submissions are forbidden`. |
| Session | `Set-Cookie: __Secure-better-auth.session_token=<token>.<sig>; Max-Age=3600; HttpOnly; Secure; SameSite=Lax` |
| Lifetime | **1 hour**, fixed. `GET /api/auth/get-session` shows `expiresAt = createdAt + 1h`. |
| Bad credentials | Form action: HTTP **200** with `{"type":"failure","status":401,...}`. Better Auth JSON: **401**. Empty/malformed email: **400**. |
| Logout | `POST /api/auth/sign-out` (the "Sign out" button) |
| Bearer tokens | Not accepted. `Authorization: Bearer <token>` → 401. The cookie is the only way in. |

Expired or missing sessions show up **differently depending on the endpoint**. This is the main robustness trap:

- `/portal/*` JSON endpoints: `401 {"error":"unauthorized","message":"A valid session is required."}`.
- SvelteKit page data (`/meters/{id}/__data.json`): **HTTP 200** with body `{"type":"redirect","location":"/login"}`. A client that only checks status codes will treat this as success.

## 3. Data endpoints

All of these need the session cookie. All return JSON. All are `GET`.

### 3.1 Meter search: `GET /portal/meters/search?q=&page=`
```json
{"data":[{"meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single",
          "installStatus":"Decommissioned","dtCode":"DT-001"}, …],
 "total":403,"page":1,"pageSize":20}
```
- `q` is a **case-insensitive substring match on meter ID or serial number only**. It does not match make, status or transformer (`q=Genus` finds 0). Whitespace is not trimmed: `q=%20J100001%20` finds 0.
- The page size is **fixed at 20**. `pageSize`/`limit` are ignored. `page=0`, `-1` and `abc` are treated as page 1. Past the end you get an empty `data`.

### 3.2 Transformers: `GET /portal/dts?page=`
```json
{"data":[{"code":"DT-001","name":"Malviya Nagar DT 1","feederCode":"F-001","capacityKva":100}, …],
 "total":40,"page":1,"pageSize":20}
```
There are 40 distribution transformers (DTs), on 2 pages. This is the only place transformer capacity appears. I treat it as the **register** (the authority) for DT names.

### 3.3 Meter detail: `GET /meters/{id}/__data.json`
This is the SvelteKit server-load data for the detail page. It is encoded in SvelteKit's **devalue "flattened" format**: one array in which objects refer to other entries by index. You need `devalue.unflatten` to read it. Decoded, the last node is:
```json
{ "meterId": "J100000",
  "detail": …two possible shapes, see below…,
  "hierarchy": { "Meter ID":"J100000", "Installation Status":"…", "Installation Type":"…",
                 "Zone":"Jaipur Zone 1 (Z-01)", "Circle":"Circle 1 (C-01)", "Division":"Division 1 (D-01)",
                 "Subdivision":"Subdivision 1 (SD-01)", "Sub Station":"Substation 1 (SS-01)",
                 "Feeder":"Feeder 1 (F-001)", "DT":"Malviya Nagar DT 1 (DT-001)" } }
```
**`detail` comes in two shapes.** The page's own JS checks `'classData' in detail` to tell them apart:
- **legacy** (238 meters): `{"data":[{"parameterName":"Serial No","parameterValue":"SE33962"}, …]}`
- **v2** (165 meters): `{"classData":"{\"installed_meter\":{\"MeterId\":…,\"SerialNo\":…,\"InstallationStatus\":…}}"}`. That is JSON *inside a string*, with PascalCase keys.

Hierarchy values are `"Name (CODE)"` strings. When a code is blank the parentheses disappear (`"Circle 6"`). When a name is blank you get `"(F-012)"`.

An unknown id returns HTTP 200 with an error node: `{"type":"error","error":{"message":"Meter not found"},"status":404}`.

### 3.4 Location: `GET /portal/meters/{id}/geo`
`{"data":{"latitude":"26.938961002479868","longitude":"75.83095696146852"}}`. The coordinates are **strings**. An unknown id → `404 {"error":"not_found","message":"Meter not found"}`.

### 3.5 Consumption: `GET /portal/meters/{id}/energy?from=&to=`
```json
{"data":[{"timestamp":"23/06/2026 23:30","kwh":"48438.74","kvah":"52313.84","voltR":"226"}, …]}
```
- These are **cumulative register readings** (the meter's kWh/kVAh counters), not consumption per interval. Every value is a **string**.
- Timestamps are `dd/mm/yyyy HH:mm` **with no time zone**.
- The page doesn't use `from`/`to` at all; I found them by probing. They take `YYYY-MM-DD`, and both ends are inclusive whole days.
  - Neither given: the **last 7 days of data the portal has**, ending `30/06/2026 23:30`. That includes the 23:30 reading of the day before, so the first interval's delta can be computed. The data window is not "now".
  - Only `from`: 7 days starting at `from`. Only `to`: the 7 days ending at `to` (clipped to the data, so `to=2026-06-05` gives 1–5 June).
  - **Invalid values are silently ignored** and you get the default window. `from=garbage`, `from=01/06/2026` and ISO date-times all do this.
  - `from > to`, or a range outside the data, gives an empty `data`.
- **All data is June 2026** (1–30 June). Wider ranges are clipped to it.

### 3.6 Bulk export: `GET /portal/export` (signed)
This is behind the "Export all meters" button on the Transformers page. **One call returns all 403 meters with everything**: detail fields, the full hierarchy as `{name, code}` objects, numeric `geo`, and a `build` field (`legacy`/`v2`) that is never shown in the UI.
```json
{"data":[{"meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single",
          "installStatus":"Decommissioned","installType":"Whole Current","build":"legacy","dtCode":"DT-001",
          "hierarchy":{"zone":{"name":"Jaipur Zone 1","code":"Z-01"}, …,"dt":{"name":"Malviya Nagar DT 1","code":"DT-001"}},
          "geo":{"lat":26.938961002479868,"lng":75.83095696146852}}, …],
 "total":403}
```
It needs a request signature, which the portal's JS computes like this (`nodes/4.*.js`):
1. `GET /portal/keys` → `{"data":{"signingSecret":"…"}}`
2. `ts = floor(now / 1000)` (Unix seconds)
3. `signature = hex(HMAC-SHA256(secret, "GET\n/portal/export\n" + query + "\n" + ts))`, where `query` is the raw query string without `?` (the UI sends `page=1`)
4. Send the headers `x-timestamp: ts` and `x-signature: signature`.

What I observed:
- The secret is **the same across sessions** and didn't change during my testing. It is not per-user.
- The timestamp must be within roughly **±5 minutes** of the server clock: −240s and +200s pass, +400s fails.
- **Replays are accepted.** The same signature worked twice.
- `page` and `pageSize` don't change anything. Every call returns all 403 rows.
- Any failure → `401 {"error":"signature_invalid",…}`, with no detail about *why*.

**This is the bulk path.** It replaces 403 × 2 detail+geo calls (more than 7 minutes under the rate limit) with 1 call (plus 1 for the key).

## 4. Rate limiting

There is no documentation and no `Retry-After` or `X-RateLimit-*` headers. I measured this:
- **120 requests per ~60-second window, per session.** After a 65-second rest, exactly 120 calls succeeded, then `429 {"error":"rate_limited","message":"Rate limit exceeded; slow down."}`.
- Waits of 2s, 5s, 10s or 20s after hitting it did **not** free any capacity. Capacity came back all at once later. So it behaves like a fixed or sliding window, not a token bucket.
- It is **shared across all `/portal/*` endpoints** (geo, search, dts, keys, energy). It does **not** apply to `/meters/{id}/__data.json` or `/api/auth/*`.
- It is **per session, not per IP.** A freshly logged-in session was not throttled while the first one was. I did *not* use this to get around the limit; the service paces a single session instead.
- Unauthenticated requests get 401 before the limiter sees them.

My first full energy scan (6 requests in parallel) hit this almost immediately: 397 of 403 calls got 429. That is how I found the limit.

## 5. The data, and what's wrong with it

There are 403 meters (`J100000`–`J100402`, contiguous), 40 transformers, 3 zones, 6 circles, 10 divisions, 14 subdivisions, 18 substations and 28 feeders.

**Hierarchy: not a tree.** Each meter carries its own zone → … → DT path.
- Zone→circle and feeder→DT are consistent.
- **Every division, subdivision and substation, and 12 of the 28 feeders, appear under more than one parent.** For example, D-01 appears under C-01 (20 meters), C-03 (10) and C-05 (10). There's no majority parent to choose. The counts are suspiciously even, which suggests the levels were assigned independently. So "the" tree cannot be reconstructed. The honest output is each meter's own path, plus a note of which nodes appear under more than one parent.
- **Blank fields:** 22 meters have a blank code or name somewhere in their path (for example circle `""`, feeder name `""`). Codes and names are 1:1 everywhere they are both present, so every blank can be recovered from the rest of the fleet.
- **Renamed DT:** meters `J100400`–`J100402` (serials `GN…`, apparently added later) put DT-007 under the name **"Old Malviya Nagar Xfmr"**. The transformer register and the other 10 meters call it **"Sanganer DT 7"**. DT-007 therefore has 13 meters; every other DT has 10.
- DT→feeder from `/portal/dts` agrees with the meter paths everywhere a feeder code is present.

**Meter attributes**
- The serial prefix does *not* tell you the make. 323 of 403 serials have a prefix that doesn't match (`SE…` on an HPL meter, `L&…` on a Genus meter). I don't infer anything from it.
- Status: Installed 238, Faulty 90, Decommissioned 75. Phase: single 277, three 126. Installation type: Whole Current 205, CT Operated 198.
- Coordinates all fall within ~27 km of central Jaipur. None are missing or out of range.

**Consumption** (a full June scan of all 403 meters)
- **Two reading resolutions:** `J100000`–`J100039` (exactly one per DT) report **every 30 minutes**, 1,440 readings in June. The other 363 report **once a day at 00:00**, 30 readings. Nothing in the meter record says which kind a meter is; the only way to tell is from the spacing between readings.
- **Duplicate rows:** 5 meters (`J100089`, `J100134`, `J100195`, `J100211`, `J100330`) end with two rows for `30/06/2026 00:00`. The second copy has an **empty** `kwh` and `voltR` but the same `kvah`.
- No gaps, no registers going backwards, kVAh ≥ kWh everywhere, voltage between 220 and 240 V.
- **Decommissioned meters keep accumulating kWh** at normal rates, for example J100000. This is either a data problem or a real field problem. It is surfaced, not hidden.
- kWh/kVAh comes out at about 0.926 for every meter (power factor). That points to synthetic data.

## 6. Other quirks
- The web UI never shows the `build` field or the export's structured `{name, code}` hierarchy. The export is a strictly richer view than the pages.
- `/meters/{id}` pages SSR the detail data, but location and energy are fetched client-side. A slow `/portal` therefore shows "Loading…" on an otherwise rendered page.
- The portal's clock (`Date` header) matched mine to within about 1 second, well inside the export signature's ±5 minute window, so the service signs with its own clock.

## 7. Which of these the service uses

| Portal endpoint | Used by the service? |
|---|---|
| `POST /api/auth/sign-in/email` | Yes, to log in (and again when the session expires) |
| `GET /portal/keys` + `GET /portal/export` | Yes, the source of every meter, its hierarchy and location |
| `GET /portal/dts` | Yes, only for the canonical transformer names |
| `GET /portal/meters/{id}/energy` | Yes, live, for each consumption request |
| `GET /portal/meters/search` | No: the export plus our own filtering covers it |
| `GET /meters/{id}/__data.json`, `GET /portal/meters/{id}/geo` | No: the export already contains the same fields |

The unused endpoints are documented above because they are how the portal's own pages work, and they would be the fallback if the export ever stopped working.
