// A local HTTP server that imitates the Urja portal's protocol closely enough
// to exercise the client: Better Auth login, session cookies, the signed
// export and 401/429 behaviour.

import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { exportRows, transformers, halfHourlyRows } from './fixtures.js';

export async function startFakePortal() {
  const state = {
    secret: 'test-secret',
    sessions: new Set(),
    logins: 0,
    rateLimitNext: 0, // respond 429 to the next N /portal/* requests
    requests: [],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const token = /__Secure-better-auth\.session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const authed = token && state.sessions.has(token);

    if (req.method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { email, password } = JSON.parse(body);
        if (req.headers.origin !== `http://127.0.0.1:${server.address().port}`) return json(403, { message: 'origin' });
        if (email !== 'op@test' || password !== 'pw') return json(401, { message: 'Invalid email or password' });
        const t = `tok${++state.logins}`;
        state.sessions.add(t);
        json(200, { token: t }, {
          'set-cookie': `__Secure-better-auth.session_token=${t}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`,
        });
      });
      return;
    }

    if (!url.pathname.startsWith('/portal/')) return json(404, { message: 'nope' });
    if (!authed) return json(401, { error: 'unauthorized', message: 'A valid session is required.' });
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--;
      return json(429, { error: 'rate_limited', message: 'Rate limit exceeded; slow down.' });
    }

    if (url.pathname === '/portal/keys') return json(200, { data: { signingSecret: state.secret } });

    if (url.pathname === '/portal/export') {
      const ts = req.headers['x-timestamp'];
      const expected = createHmac('sha256', state.secret)
        .update(['GET', '/portal/export', url.search.slice(1), ts].join('\n'))
        .digest('hex');
      const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
      if (!fresh || req.headers['x-signature'] !== expected) {
        return json(401, { error: 'signature_invalid', message: 'Missing or invalid request signature.' });
      }
      return json(200, { data: exportRows, total: exportRows.length });
    }

    if (url.pathname === '/portal/dts') {
      const p = Number(url.searchParams.get('page') ?? 1);
      // Use a page size of 1 to exercise pagination.
      return json(200, { data: transformers.slice(p - 1, p), total: transformers.length, page: p, pageSize: 1 });
    }

    const energy = /^\/portal\/meters\/([^/]+)\/energy$/.exec(url.pathname);
    if (energy) {
      if (!exportRows.some((r) => r.meterId === energy[1])) return json(404, { error: 'not_found', message: 'Meter not found' });
      return json(200, { data: halfHourlyRows(1, 3) });
    }

    json(404, { error: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    state,
    expireAllSessions: () => state.sessions.clear(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
