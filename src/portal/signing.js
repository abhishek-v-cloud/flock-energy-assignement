import { createHmac } from 'node:crypto';

/**
 * Reproduces the request signature the portal's own frontend computes for
 * `/portal/export` (see PROTOCOL.md):
 *
 *   signature = hex(HMAC-SHA256(secret, METHOD + "\n" + PATH + "\n" + QUERY + "\n" + UNIX_SECONDS))
 *
 * QUERY is the raw query string without the leading "?".
 */
export function signRequest({ method, path, query, secret, nowMs }) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const payload = [method.toUpperCase(), path, query, timestamp].join('\n');
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return { timestamp, signature };
}
