// End-to-end: real app, service, catalogue and client, talking to the fake portal.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakePortal } from './fakePortal.js';
import { PortalClient } from '../src/portal/client.js';
import { MeterCatalogue } from '../src/domain/catalogue.js';
import { MeterService } from '../src/service.js';
import { createApp } from '../src/app.js';

describe('HTTP API', () => {
  let portal;
  let server;
  let base;

  before(async () => {
    portal = await startFakePortal();
    const logger = {};
    const client = new PortalClient({
      baseUrl: portal.baseUrl, email: 'op@test', password: 'pw', sleep: async () => {}, logger, maxWaitMs: 0,
    });
    const catalogue = new MeterCatalogue({ client, ttlMs: 60_000, maxStaleMs: 3_600_000, logger });
    const service = new MeterService({ client, catalogue, consumptionTtlMs: 60_000 });
    server = createApp({ service, logger }).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await portal.close();
  });

  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };

  test('GET /api/v1/meters lists meters with pagination and freshness metadata', async () => {
    const { status, body } = await get('/api/v1/meters?pageSize=2');
    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.pagination, { page: 1, pageSize: 2, total: 4, totalPages: 2 });
    assert.equal(body.meta.source, 'catalogue-cache');
  });

  test('filters combine', async () => {
    const { body } = await get('/api/v1/meters?status=installed,faulty&phase=three');
    assert.deepEqual(body.data.map((m) => m.meterId), ['J100011', 'J100400']);
  });

  test('rejects bad values with details', async () => {
    const { status, body } = await get('/api/v1/meters?status=broken&pageSize=0');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
    assert.deepEqual(body.error.details.map((d) => d.param).sort(), ['pageSize', 'status']);
  });

  test('GET /api/v1/meters/:id is case-insensitive and 404s cleanly', async () => {
    assert.equal((await get('/api/v1/meters/j100004')).body.data.meterId, 'J100004');
    const missing = await get('/api/v1/meters/NOPE');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  });

  test('GET consumption returns typed, windowed data and caches it', async () => {
    const path = '/api/v1/meters/J100000/consumption?from=2026-06-01&to=2026-06-01';
    const first = await get(path);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.series.length, 48);
    assert.equal(first.body.data.totalKwh, 24);
    assert.equal(first.body.meta.source, 'portal');
    assert.match(first.body.data.notes.join(' '), /decommissioned/);
    const second = await get(path);
    assert.equal(second.body.meta.source, 'cache');
  });

  test('consumption validates dates', async () => {
    const { status, body } = await get('/api/v1/meters/J100000/consumption?from=2026-06-31');
    assert.equal(status, 400);
    assert.equal(body.error.details[0].param, 'from');
  });

  test('GET /api/v1/hierarchy returns the tree and per-level consistency', async () => {
    const { body } = await get('/api/v1/hierarchy?depth=1');
    assert.equal(body.data.tree.meterCount, 4);
    assert.equal(body.data.tree.children[0].childCount, 1);
    const division = body.data.consistency.find((c) => c.level === 'division');
    assert.deepEqual(division, { level: 'division', nodeCount: 1, nodesWithMultipleParents: 1 });
    assert.equal((await get('/api/v1/hierarchy?depth=99')).status, 400);
  });

  test('portal rate limiting becomes a 503 with Retry-After', async () => {
    portal.state.rateLimitNext = 5;
    const { status, headers, body } = await get('/api/v1/meters/J100004/consumption?from=2026-06-02');
    portal.state.rateLimitNext = 0;
    assert.equal(status, 503);
    assert.equal(body.error.code, 'portal_rate_limited');
    assert.ok(headers.get('retry-after'));
  });

  test('every path in openapi.json is actually routed', async () => {
    const spec = (await get('/openapi.json')).body;
    const samples = { meterId: 'J100000' };
    for (const path of Object.keys(spec.paths)) {
      const url = path.replace(/\{(\w+)\}/g, (_, name) => samples[name]);
      const { body } = await get(url);
      assert.notEqual(body.error?.code, 'route_not_found', `${path} is documented but not routed`);
    }
  });

  test('OpenAPI document and unknown routes', async () => {
    const spec = await get('/openapi.json');
    assert.match(spec.body.openapi, /^3\./);
    assert.equal((await get('/api/v1/nope')).status, 404);
  });
});
