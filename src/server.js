import { assertPortalCredentials, config } from './config.js';
import { PortalClient } from './portal/client.js';
import { MeterCatalogue } from './domain/catalogue.js';
import { MeterService } from './service.js';
import { createApp } from './app.js';

assertPortalCredentials();

const client = new PortalClient(config.portal);
const catalogue = new MeterCatalogue({
  client,
  ttlMs: config.cache.catalogueTtlSeconds * 1000,
  maxStaleMs: config.cache.catalogueMaxStaleSeconds * 1000,
});
const service = new MeterService({
  client,
  catalogue,
  consumptionTtlMs: config.cache.consumptionTtlSeconds * 1000,
  consumptionMaxEntries: config.cache.consumptionMaxEntries,
});

const app = createApp({ service });

const server = app.listen(config.port, () => {
  console.info(`[server] listening on http://localhost:${config.port}  (docs: /docs)`);
  // Warm the catalogue so the first API call doesn't pay for the bulk export.
  catalogue.refresh().catch((err) => console.warn(`[server] initial catalogue load failed: ${err.message}`));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
