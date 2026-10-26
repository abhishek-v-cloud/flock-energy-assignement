// Consumption maths. The portal returns *cumulative register readings*
// (kWh / kVAh meter counters) as strings, with "dd/mm/yyyy HH:mm" timestamps.
// We turn them into energy per interval: the difference between consecutive readings.

// Portal timestamps carry no zone. The utility is in Jaipur, so we treat them
// as India Standard Time (UTC+05:30, no DST) — see README assumptions.
const IST_OFFSET_MS = 330 * 60_000;

const pad = (n) => String(n).padStart(2, '0');
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const round = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

/** "23/06/2026 23:30" -> epoch ms (interpreted as IST), or null. */
export function parsePortalTimestamp(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m.map(Number);
  return Date.UTC(yyyy, mm - 1, dd, hh, min) - IST_OFFSET_MS;
}

/** epoch ms -> "2026-06-23T23:30:00+05:30" */
export function toIstIso(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+05:30`
  );
}

/** "YYYY-MM-DD" (IST calendar day) -> epoch ms of its 00:00 IST. */
export function istDayStart(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Raw portal rows -> sorted readings, one per timestamp.
 * Some meters repeat their last timestamp with blank kWh/voltage; we keep the
 * row with more values filled in.
 */
export function normalizeReadings(rows) {
  const byTime = new Map();
  let duplicates = 0;
  const filled = (r) => [r.kwh, r.kvah, r.voltageR].filter((v) => v !== null).length;
  for (const row of rows ?? []) {
    const at = parsePortalTimestamp(row.timestamp);
    if (at === null) continue;
    const reading = { at, kwh: num(row.kwh), kvah: num(row.kvah), voltageR: num(row.voltR) };
    const existing = byTime.get(at);
    if (existing) {
      duplicates++;
      if (filled(reading) <= filled(existing)) continue;
    }
    byTime.set(at, reading);
  }
  return { readings: [...byTime.values()].sort((a, b) => a.at - b.at), duplicates };
}

/**
 * Builds the API's consumption payload from raw portal rows.
 * Each interval runs from one reading to the next and is labelled by its start.
 * A missing reading, or a register that goes backwards, gives `null` energy.
 *
 * @param window `{ startMs, endMs }` keeps intervals starting in [start, end); null keeps all
 */
export function buildConsumption(rows, { window = null } = {}) {
  const { readings, duplicates } = normalizeReadings(rows);
  const delta = (a, b) => (a === null || b === null || b < a ? null : b - a);

  let series = [];
  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1];
    const cur = readings[i];
    series.push({ start: prev.at, end: cur.at, kwh: delta(prev.kwh, cur.kwh), kvah: delta(prev.kvah, cur.kvah), voltageR: cur.voltageR });
  }
  if (window) series = series.filter((s) => s.start >= window.startMs && s.start < window.endMs);

  const sum = (key) => round(series.reduce((total, s) => total + (s[key] ?? 0), 0));
  return {
    totalKwh: sum('kwh'),
    totalKvah: sum('kvah'),
    series: series.map((s) => ({ ...s, start: toIstIso(s.start), end: toIstIso(s.end), kwh: round(s.kwh), kvah: round(s.kvah) })),
    notes: duplicates ? [`${duplicates} duplicate reading(s) collapsed (kept the most complete row).`] : [],
  };
}
