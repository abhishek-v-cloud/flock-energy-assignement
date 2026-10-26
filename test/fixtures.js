// Small, hand-made samples shaped exactly like real portal payloads
// (copied from recon, trimmed), including the anomalies we handle.

const path = (zone, circle, division, subdivision, substation, feeder, dt) => ({
  zone, circle, division, subdivision, substation, feeder, dt,
});
const n = (name, code) => ({ name, code });

export const exportRows = [
  {
    meterId: 'J100000', serialNo: 'SE33962', make: 'HPL', phaseType: 'single', installStatus: 'Decommissioned',
    installType: 'Whole Current', build: 'legacy', dtCode: 'DT-001',
    hierarchy: path(n('Jaipur Zone 1', 'Z-01'), n('Circle 1', 'C-01'), n('Division 1', 'D-01'), n('Subdivision 1', 'SD-01'),
      n('Substation 1', 'SS-01'), n('Feeder 1', 'F-001'), n('Malviya Nagar DT 1', 'DT-001')),
    geo: { lat: 26.938961002479868, lng: 75.83095696146852 },
  },
  {
    // Same division as above but under a different circle — the hierarchy is not a strict tree.
    meterId: 'J100004', serialNo: 'SE65293', make: 'Genus', phaseType: 'single', installStatus: 'Faulty',
    installType: 'CT Operated', build: 'v2', dtCode: 'DT-005',
    hierarchy: path(n('Jaipur Zone 2', 'Z-02'), n('Circle 5', 'C-05'), n('Division 1', 'D-01'), n('Subdivision 5', 'SD-05'),
      n('Substation 5', 'SS-05'), n('Feeder 5', 'F-005'), n('Bani Park DT 5', 'DT-005')),
    geo: { lat: 26.85, lng: 75.8 },
  },
  {
    // Blank circle code; the circle name is known elsewhere.
    meterId: 'J100011', serialNo: 'SE48422', make: 'HPL', phaseType: 'three', installStatus: 'Installed',
    installType: 'Whole Current', build: 'legacy', dtCode: 'DT-005',
    hierarchy: path(n('Jaipur Zone 2', 'Z-02'), n('Circle 5', ''), n('Division 1', 'D-01'), n('Subdivision 5', 'SD-05'),
      n('Substation 5', 'SS-05'), n('', 'F-005'), n('Bani Park DT 5', 'DT-005')),
    geo: { lat: 26.851, lng: 75.801 },
  },
  {
    // Stale transformer name — the register calls DT-001 "Malviya Nagar DT 1".
    meterId: 'J100400', serialNo: 'GN31592', make: 'Genus', phaseType: 'three', installStatus: 'Installed',
    installType: 'CT Operated', build: 'legacy', dtCode: 'DT-001',
    hierarchy: path(n('Jaipur Zone 1', 'Z-01'), n('Circle 1', 'C-01'), n('Division 1', 'D-01'), n('Subdivision 1', 'SD-01'),
      n('Substation 1', 'SS-01'), n('Feeder 1', 'F-001'), n('Old Malviya Nagar Xfmr', 'DT-001')),
    geo: { lat: 26.9, lng: 75.75 },
  },
];

export const transformers = [
  { code: 'DT-001', name: 'Malviya Nagar DT 1', feederCode: 'F-001', capacityKva: 100 },
  { code: 'DT-005', name: 'Bani Park DT 5', feederCode: 'F-005', capacityKva: 63 },
];

/** Half-hourly readings, like meters J100000–J100039. */
export function halfHourlyRows(startDay = 1, days = 2, startKwh = 1000) {
  const rows = [];
  let kwh = startKwh;
  for (let d = startDay; d < startDay + days; d++) {
    for (let slot = 0; slot < 48; slot++) {
      const hh = String(Math.floor(slot / 2)).padStart(2, '0');
      const mm = slot % 2 ? '30' : '00';
      rows.push({
        timestamp: `${String(d).padStart(2, '0')}/06/2026 ${hh}:${mm}`,
        kwh: kwh.toFixed(2),
        kvah: (kwh * 1.08).toFixed(2),
        voltR: String(220 + (slot % 20)),
      });
      kwh += 0.5;
    }
  }
  return rows;
}

/** Daily midnight readings with the trailing blank duplicate seen on 5 real meters. */
export const dailyRowsWithDuplicate = [
  { timestamp: '28/06/2026 00:00', kwh: '12717.05', kvah: '13734.42', voltR: '235' },
  { timestamp: '29/06/2026 00:00', kwh: '12724.7', kvah: '13742.67', voltR: '232' },
  { timestamp: '30/06/2026 00:00', kwh: '12732.34', kvah: '13750.93', voltR: '229' },
  { timestamp: '30/06/2026 00:00', kwh: '', kvah: '13750.93', voltR: '' },
];

