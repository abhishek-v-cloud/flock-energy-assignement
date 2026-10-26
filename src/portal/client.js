// Adapter for the Urja Meter Ops portal. This is the only module that knows
// how the portal speaks HTTP: auth, cookies, the export signature, its rate
// limit and its error shapes. It returns the portal's own payloads; turning
// them into our clean model is the domain layer's job.

import { SlidingWindowLimiter } from '../util/rateLimiter.js';
import { signRequest } from './signing.js';
import {
  PortalAuthError,
  PortalNotFoundError,
  PortalRateLimitedError,
  PortalUnavailableError,
} from './errors.js';

const SESSION_COOKIE = '__Secure-better-auth.session_token';
const DEFAULT_SESSION_SECONDS = 3600;
// Re-login slightly before the portal would expire us, so an in-flight request
// never races the expiry.
const SESSION_REFRESH_MARGIN_MS = 60_000;
const MAX_TRANSIENT_RETRIES = 2;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PortalClient {
  constructor({
    baseUrl,
    email,
    password,
    timeoutMs = 15_000,
    rateLimitPerMinute = 100,
    maxWaitMs = 30_000,
    fetch = globalThis.fetch,
    now = Date.now,
    sleep = realSleep,
    logger = console,
  }) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.maxWaitMs = maxWaitMs;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.limiter = new SlidingWindowLimiter({ limit: rateLimitPerMinute, now, wait: sleep });

    this.session = null; // { cookie, expiresAt }
    this.loginInFlight = null;
    this.signingSecret = null;
  }

  // ---------------------------------------------------------------- endpoints

  /** One page (20 rows) of distribution transformers. */
  listTransformers({ page = 1 } = {}) {
    return this.#getJson('/portal/dts', { page: String(page) });
  }

  /** All transformers, following pagination. */
  async listAllTransformers() {
    const first = await this.listTransformers({ page: 1 });
    const pages = Math.ceil(first.total / first.pageSize);
    const rows = [...first.data];
    for (let page = 2; page <= pages; page++) {
      rows.push(...(await this.listTransformers({ page })).data);
    }
    return rows;
  }

  /**
   * Bulk export of every meter with hierarchy and coordinates. Requires the
   * HMAC signature the portal's "Export all meters" button computes.
   */
  async exportMeters() {
    const body = await this.#getJson('/portal/export', { page: '1' }, { signed: true });
    if (!Array.isArray(body.data)) throw new PortalUnavailableError('Export returned no data array');
    return body;
  }

  /**
   * Interval register readings. `from`/`to` are YYYY-MM-DD. With neither, the
   * portal returns its own default window (the last 7 days of data it has).
   */
  async getMeterEnergy(meterId, { from, to } = {}) {
    const query = {};
    if (from) query.from = from;
    if (to) query.to = to;
    return (await this.#getJson(`/portal/meters/${encodeURIComponent(meterId)}/energy`, query)).data;
  }

  async getSigningSecret({ refresh = false } = {}) {
    if (!this.signingSecret || refresh) {
      const body = await this.#getJson('/portal/keys');
      this.signingSecret = body?.data?.signingSecret;
      if (!this.signingSecret) throw new PortalUnavailableError('Portal returned no signing secret');
    }
    return this.signingSecret;
  }

  // ---------------------------------------------------------------- session

  async #ensureSession() {
    if (this.session && this.session.expiresAt - this.now() > SESSION_REFRESH_MARGIN_MS) return;
    // Single-flight: concurrent callers share one login.
    this.loginInFlight ??= this.#login().finally(() => {
      this.loginInFlight = null;
    });
    await this.loginInFlight;
  }

  async #login() {
    this.logger.info?.('[portal] logging in');
    let res;
    try {
      // Better Auth's JSON endpoint — the same backend the portal's login form
      // action calls. The Origin header is required by its CSRF check.
      res = await this.fetch(`${this.baseUrl}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: this.baseUrl },
        body: JSON.stringify({ email: this.email, password: this.password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PortalUnavailableError(`Login request failed: ${err.message}`, { cause: err });
    }
    // 400 = malformed credentials (e.g. empty email), 401 = wrong password, 403 = CSRF/origin check.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new PortalAuthError(`Portal rejected our credentials (HTTP ${res.status})`);
    }
    if (!res.ok) throw new PortalUnavailableError(`Login failed with HTTP ${res.status}`);

    const cookieHeader = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!cookieHeader) throw new PortalAuthError('Login succeeded but no session cookie was set');
    const cookie = cookieHeader.split(';')[0];
    const maxAge = Number(/max-age=(\d+)/i.exec(cookieHeader)?.[1] ?? DEFAULT_SESSION_SECONDS);
    this.session = { cookie, expiresAt: this.now() + maxAge * 1000 };
  }

  // ---------------------------------------------------------------- transport

  async #getJson(path, query = {}, { signed = false } = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const deadline = this.now() + this.maxWaitMs;
    let reauthed = false;
    let resigned = false;
    let transientFailures = 0;
    let backoffMs = 2_000;

    for (;;) {
      await this.limiter.acquire();
      await this.#ensureSession();

      const headers = { cookie: this.session.cookie, accept: 'application/json' };
      if (signed) {
        const secret = await this.getSigningSecret();
        const { timestamp, signature } = signRequest({
          method: 'GET',
          path,
          query: qs,
          secret,
          nowMs: this.now(),
        });
        headers['x-timestamp'] = timestamp;
        headers['x-signature'] = signature;
      }

      let res;
      try {
        res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (transientFailures++ < MAX_TRANSIENT_RETRIES) {
          await this.sleep(500 * transientFailures);
          continue;
        }
        throw new PortalUnavailableError(`Portal unreachable: ${err.message}`, { cause: err });
      }

      if (res.status === 429) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          throw new PortalRateLimitedError('Portal rate limit exceeded; try again shortly');
        }
        // No Retry-After header is sent; the window is ~60s, so back off exponentially.
        await this.sleep(Math.min(backoffMs, remaining));
        backoffMs *= 2;
        continue;
      }

      if (res.status >= 500) {
        if (transientFailures++ < MAX_TRANSIENT_RETRIES) {
          await this.sleep(500 * transientFailures);
          continue;
        }
        throw new PortalUnavailableError(`Portal returned HTTP ${res.status}`);
      }

      const body = await this.#readJson(res, url);

      // An expired session: /portal/* endpoints answer 401 "unauthorized".
      if (res.status === 401 && body?.error === 'unauthorized') {
        if (reauthed) throw new PortalAuthError('Session rejected immediately after login');
        reauthed = true;
        this.session = null;
        continue;
      }

      if (res.status === 401 && body?.error === 'signature_invalid') {
        if (resigned) throw new PortalUnavailableError('Portal rejected our export signature');
        resigned = true;
        await this.getSigningSecret({ refresh: true }); // the secret may have rotated
        continue;
      }

      if (res.status === 404) throw new PortalNotFoundError(body?.message || 'Not found');
      if (!res.ok) {
        throw new PortalUnavailableError(`Portal returned HTTP ${res.status}: ${body?.message ?? ''}`);
      }
      return body;
    }
  }

  async #readJson(res, url) {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new PortalUnavailableError(`Non-JSON response from ${url} (HTTP ${res.status})`);
    }
  }

}
