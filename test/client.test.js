import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakePortal } from './fakePortal.js';
import { PortalClient } from '../src/portal/client.js';
import { PortalAuthError, PortalNotFoundError, PortalRateLimitedError } from '../src/portal/errors.js';

const silent = {};
const noSleep = async () => {};

describe('PortalClient against a fake portal', () => {
  let portal;
  const makeClient = (overrides = {}) =>
    new PortalClient({
      baseUrl: portal.baseUrl,
      email: 'op@test',
      password: 'pw',
      sleep: noSleep,
      logger: silent,
      ...overrides,
    });

  before(async () => {
    portal = await startFakePortal();
  });
  after(() => portal.close());
  beforeEach(() => {
    portal.state.rateLimitNext = 0;
    portal.state.secret = 'test-secret';
  });

  test('logs in lazily and reuses the session cookie', async () => {
    const client = makeClient();
    const before = portal.state.logins;
    await client.getMeterEnergy('J100000');
    await client.getMeterEnergy('J100004');
    assert.equal(portal.state.logins - before, 1);
  });

  test('concurrent first requests share a single login', async () => {
    const client = makeClient();
    const before = portal.state.logins;
    await Promise.all([1, 2, 3, 4].map(() => client.getMeterEnergy('J100000')));
    assert.equal(portal.state.logins - before, 1);
  });

  test('re-authenticates transparently when the session expires', async () => {
    const client = makeClient();
    const before = portal.state.logins;
    await client.getMeterEnergy('J100000');
    portal.expireAllSessions();
    const rows = await client.getMeterEnergy('J100000');
    assert.ok(rows.length > 0);
    assert.equal(portal.state.logins - before, 2);
  });

  test('signs export requests the way the portal expects', async () => {
    const body = await makeClient().exportMeters();
    assert.equal(body.data.length, 4);
  });

  test('refetches the signing secret once if the portal rotated it', async () => {
    const client = makeClient();
    await client.exportMeters(); // caches 'test-secret'
    portal.state.secret = 'rotated';
    const body = await client.exportMeters();
    assert.equal(body.data.length, 4);
    assert.equal(client.signingSecret, 'rotated');
  });

  test('follows transformer pagination', async () => {
    const rows = await makeClient().listAllTransformers();
    assert.deepEqual(rows.map((r) => r.code), ['DT-001', 'DT-005']);
  });

  test('backs off and retries on 429', async () => {
    const client = makeClient();
    await client.getMeterEnergy('J100000');
    portal.state.rateLimitNext = 2;
    const rows = await client.getMeterEnergy('J100000');
    assert.ok(rows.length > 0);
    assert.equal(portal.state.rateLimitNext, 0);
  });

  test('gives up with PortalRateLimitedError once the wait budget is spent', async () => {
    let fakeNow = 0;
    const client = makeClient({
      maxWaitMs: 5_000,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    });
    await client.getMeterEnergy('J100000');
    portal.state.rateLimitNext = 100;
    await assert.rejects(client.getMeterEnergy('J100000'), PortalRateLimitedError);
  });

  test('surfaces bad credentials as PortalAuthError', async () => {
    await assert.rejects(makeClient({ password: 'wrong' }).getMeterEnergy('J100000'), PortalAuthError);
  });

  test('maps portal 404s to PortalNotFoundError', async () => {
    await assert.rejects(makeClient().getMeterEnergy('NOPE'), PortalNotFoundError);
  });
});
