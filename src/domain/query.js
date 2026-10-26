// In-memory query layer over the catalogue — the filtering the portal itself
// can't do (it only supports substring search on id/serial).
// Everything is a linear scan; at ~400 meters that is microseconds.

import { LEVEL_KEYS } from './meters.js';

/**
 * @param f validated filters: { q, status[], make[], phase[], network: { [level]: code[] } }
 */
export function filterMeters(meters, f) {
  const q = f.q?.trim().toLowerCase();
  const inSet = (list, value) => !list?.length || list.includes(String(value ?? '').toLowerCase());

  return meters.filter((m) => {
    if (q && !m.meterId.toLowerCase().includes(q) && !(m.serialNumber ?? '').toLowerCase().includes(q)) return false;
    if (!inSet(f.status, m.status) || !inSet(f.make, m.make) || !inSet(f.phase, m.phase)) return false;
    return LEVEL_KEYS.every((level) => inSet(f.network?.[level], m.network[level].code));
  });
}

export function paginate(rows, page, pageSize) {
  const total = rows.length;
  return {
    data: rows.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}
