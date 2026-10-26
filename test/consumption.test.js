import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConsumption,
  normalizeReadings,
  parsePortalTimestamp,
  toIstIso,
} from '../src/domain/consumption.js';
import { dailyRowsWithDuplicate, halfHourlyRows } from './fixtures.js';

describe('timestamps', () => {
  test('portal dd/mm/yyyy HH:mm is read as IST and rendered as ISO 8601', () => {
    const ms = parsePortalTimestamp('23/06/2026 23:30');
    assert.equal(new Date(ms).toISOString(), '2026-06-23T18:00:00.000Z');
    assert.equal(toIstIso(ms), '2026-06-23T23:30:00+05:30');
  });

  test('rejects malformed timestamps', () => {
    assert.equal(parsePortalTimestamp('2026-06-23 23:30'), null);
    assert.equal(parsePortalTimestamp(''), null);
  });
});

describe('normalizeReadings', () => {
  test('collapses duplicate timestamps, keeping the most complete row', () => {
    const { readings, duplicates } = normalizeReadings(dailyRowsWithDuplicate);
    assert.equal(duplicates, 1);
    assert.equal(readings.length, 3);
    assert.equal(readings.at(-1).kwh, 12732.34);
    assert.equal(readings.at(-1).voltageR, 229);
  });

  test('turns blank strings into null rather than 0', () => {
    const { readings } = normalizeReadings([{ timestamp: '01/06/2026 00:00', kwh: '', kvah: '5', voltR: '' }]);
    assert.deepEqual([readings[0].kwh, readings[0].kvah, readings[0].voltageR], [null, 5, null]);
  });

  test('sorts out-of-order rows', () => {
    const rows = halfHourlyRows(1, 1).reverse();
    const { readings } = normalizeReadings(rows);
    assert.ok(readings.every((r, i) => i === 0 || r.at > readings[i - 1].at));
  });
});

describe('buildConsumption', () => {
  test('intervals are deltas of the cumulative register', () => {
    const out = buildConsumption(halfHourlyRows(1, 1, 1000));
    assert.equal(out.series.length, 47);
    assert.equal(out.series[0].kwh, 0.5);
    assert.equal(out.series[0].start, '2026-06-01T00:00:00+05:30');
    assert.equal(out.series[0].end, '2026-06-01T00:30:00+05:30');
    assert.equal(out.totalKwh, 23.5);
  });

  test("windows to whole IST days, using the next day's first reading to close the last interval", () => {
    const startMs = parsePortalTimestamp('01/06/2026 00:00');
    const out = buildConsumption(halfHourlyRows(1, 3), { window: { startMs, endMs: startMs + 86_400_000 } });
    assert.equal(out.series.length, 48);
    assert.equal(out.totalKwh, 24);
  });

  test('a register that goes backwards gives null energy, not a negative number', () => {
    const rows = [
      { timestamp: '01/06/2026 00:00', kwh: '100', kvah: '110', voltR: '230' },
      { timestamp: '02/06/2026 00:00', kwh: '90', kvah: '100', voltR: '230' },
      { timestamp: '03/06/2026 00:00', kwh: '95', kvah: '106', voltR: '230' },
    ];
    const out = buildConsumption(rows);
    assert.equal(out.series[0].kwh, null);
    assert.equal(out.totalKwh, 5);
  });

  test('notes collapsed duplicates', () => {
    assert.match(buildConsumption(dailyRowsWithDuplicate).notes.join(' '), /duplicate/);
  });

  test('empty input yields an empty, well-formed payload', () => {
    const out = buildConsumption([]);
    assert.deepEqual(out, { totalKwh: 0, totalKvah: 0, series: [], notes: [] });
  });
});
