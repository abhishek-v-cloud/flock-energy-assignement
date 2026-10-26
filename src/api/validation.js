// Query-string validation. The portal silently ignores bad input (e.g. an
// unparseable date falls back to its default window); we reject it with a 400
// instead, so callers find out immediately.

import { LEVEL_KEYS } from '../domain/meters.js';
import { addDays } from '../domain/consumption.js';

export class ValidationError extends Error {
  constructor(details) {
    super('Invalid request parameters');
    this.code = 'invalid_request';
    this.details = details;
  }
}

const STATUSES = ['installed', 'faulty', 'decommissioned'];
const MAX_CONSUMPTION_DAYS = 92;

/** Comma-separated, case-insensitive list, or undefined when absent. */
const list = (v) => (v ? String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined);

function intParam(errors, query, name, { min, max, fallback }) {
  if (query[name] === undefined) return fallback;
  const n = Number(query[name]);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  errors.push({ param: name, message: `Must be an integer between ${min} and ${max}` });
  return fallback;
}

function dateParam(errors, query, name) {
  const v = query[name];
  if (v === undefined) return undefined;
  // Round-tripping through Date rejects impossible dates like 2026-02-30.
  const parsed = new Date(`${v}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(v)) return v;
  errors.push({ param: name, message: 'Must be a calendar date, YYYY-MM-DD' });
  return undefined;
}

function done(errors, value) {
  if (errors.length) throw new ValidationError(errors);
  return value;
}

export function parseMeterListQuery(query) {
  const errors = [];
  const status = list(query.status);
  const bad = status?.filter((s) => !STATUSES.includes(s)) ?? [];
  if (bad.length) errors.push({ param: 'status', message: `Unknown value(s) ${bad.join(', ')}. Allowed: ${STATUSES.join(', ')}` });

  const network = {};
  for (const level of LEVEL_KEYS) if (query[level]) network[level] = list(query[level]);

  return done(errors, {
    filters: { q: query.q, status, make: list(query.make), phase: list(query.phase), network },
    paging: {
      page: intParam(errors, query, 'page', { min: 1, max: 100_000, fallback: 1 }),
      pageSize: intParam(errors, query, 'pageSize', { min: 1, max: 500, fallback: 50 }),
    },
  });
}

export function parseConsumptionQuery(query) {
  const errors = [];
  let from = dateParam(errors, query, 'from');
  let to = dateParam(errors, query, 'to');

  // Mirror the portal: one bound alone means a 7-day window anchored on it.
  if (from && !to) to = addDays(from, 6);
  if (to && !from) from = addDays(to, -6);
  if (from && to) {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (days < 1) errors.push({ param: 'to', message: 'Must be on or after from' });
    if (days > MAX_CONSUMPTION_DAYS) errors.push({ param: 'to', message: `Window may span at most ${MAX_CONSUMPTION_DAYS} days` });
  }
  return done(errors, { from: from ?? null, to: to ?? null });
}

export function parseHierarchyQuery(query) {
  const errors = [];
  const depth = intParam(errors, query, 'depth', { min: 0, max: LEVEL_KEYS.length, fallback: undefined });
  return done(errors, { depth });
}
