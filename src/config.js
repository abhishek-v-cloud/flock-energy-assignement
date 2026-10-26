// Central configuration. Everything is overridable via environment variables
// (or a local .env file, loaded with Node's built-in loader — no dotenv needed).

try {
  process.loadEnvFile();
} catch {
  // No .env file — fall back to real environment variables / defaults.
}

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return n;
};

export const config = {
  port: int('PORT', 3000),

  portal: {
    baseUrl: (process.env.PORTAL_BASE_URL || 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
    email: process.env.PORTAL_EMAIL || '',
    password: process.env.PORTAL_PASSWORD || '',
    timeoutMs: int('PORTAL_TIMEOUT_MS', 15_000),
    // The portal allows 120 requests per ~60s window per session. We budget
    // below that so a burst from our side never trips it.
    rateLimitPerMinute: int('PORTAL_RATE_LIMIT_PER_MINUTE', 100),
    // How long a caller is allowed to wait (queueing + 429 back-off) before we give up.
    maxWaitMs: int('PORTAL_MAX_WAIT_MS', 30_000),
  },

  cache: {
    // Meter / transformer master data: changes rarely, one bulk call to refresh.
    catalogueTtlSeconds: int('CATALOGUE_TTL_SECONDS', 15 * 60),
    // If a refresh fails, keep serving the last good copy for this long.
    catalogueMaxStaleSeconds: int('CATALOGUE_MAX_STALE_SECONDS', 24 * 60 * 60),
    // Consumption windows that may still receive new readings.
    consumptionTtlSeconds: int('CONSUMPTION_TTL_SECONDS', 5 * 60),
    consumptionMaxEntries: int('CONSUMPTION_MAX_ENTRIES', 500),
  },
};

export function assertPortalCredentials(cfg = config) {
  if (!cfg.portal.email || !cfg.portal.password) {
    throw new Error(
      'PORTAL_EMAIL and PORTAL_PASSWORD must be set (copy .env.example to .env).',
    );
  }
}
