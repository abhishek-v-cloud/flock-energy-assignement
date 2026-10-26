import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { apiRoutes } from './api/routes.js';
import { ValidationError } from './api/validation.js';
import { NotFoundError } from './service.js';
import {
  PortalAuthError,
  PortalNotFoundError,
  PortalRateLimitedError,
  PortalUnavailableError,
} from './portal/errors.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const openapi = JSON.parse(readFileSync(root('openapi.json'), 'utf8'));

/** Builds the Express app. Dependencies are injected so tests can use fakes. */
export function createApp({ service, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple'); // flat strings only — no nested objects from ?a[b]=c

  app.get('/openapi.json', (req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Urja Meter API docs' }));
  app.use('/api/v1', apiRoutes(service));

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'route_not_found', message: `No route for ${req.method} ${req.path}` } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const send = (status, code, message, extra = {}) => res.status(status).json({ error: { code, message, ...extra } });

    if (err instanceof ValidationError) return send(400, err.code, err.message, { details: err.details });
    if (err instanceof NotFoundError || err instanceof PortalNotFoundError) return send(404, 'not_found', err.message);
    if (err instanceof PortalRateLimitedError) {
      res.set('Retry-After', String(err.retryAfterSeconds));
      return send(503, err.code, 'The upstream portal is rate limiting us; retry shortly.');
    }
    if (err instanceof PortalAuthError) {
      logger.error?.(`[api] portal auth failure: ${err.message}`);
      return send(502, err.code, 'Could not authenticate with the upstream portal.');
    }
    if (err instanceof PortalUnavailableError) {
      logger.error?.(`[api] portal unavailable: ${err.message}`);
      return send(502, err.code, 'The upstream portal is unavailable or returned an unexpected response.');
    }
    logger.error?.(err);
    return send(500, 'internal_error', 'Unexpected server error.');
  });

  return app;
}
