// Turns the portal's bulk-export meter records into our clean model and
// repairs their hierarchy. See PROTOCOL.md for the raw shapes.

/** Network levels from the top down, with the key the export uses for each. */
export const LEVELS = [
  { key: 'zone', exportKey: 'zone' },
  { key: 'circle', exportKey: 'circle' },
  { key: 'division', exportKey: 'division' },
  { key: 'subdivision', exportKey: 'subdivision' },
  { key: 'substation', exportKey: 'substation' },
  { key: 'feeder', exportKey: 'feeder' },
  { key: 'transformer', exportKey: 'dt' },
];
export const LEVEL_KEYS = LEVELS.map((l) => l.key);

const STATUS = { installed: 'installed', faulty: 'faulty', decommissioned: 'decommissioned' };
const INSTALLATION_TYPE = { 'whole current': 'whole_current', 'ct operated': 'ct_operated' };
const PHASE = { single: 'single', three: 'three' };

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const toEnum = (table, raw) => {
  const v = clean(raw).toLowerCase();
  return table[v] ?? (v ? v.replace(/\s+/g, '_') : null);
};
const toNumber = (v) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(clean(v));
  return Number.isFinite(n) ? n : null;
};
const nodeRef = (n) => ({ code: clean(n?.code) || null, name: clean(n?.name) || null });

function baseMeter({ meterId, serialNo, make, phaseType, installStatus, installType }) {
  return {
    meterId: clean(meterId),
    serialNumber: clean(serialNo) || null,
    make: clean(make) || null,
    phase: toEnum(PHASE, phaseType),
    status: toEnum(STATUS, installStatus),
    installationType: toEnum(INSTALLATION_TYPE, installType),
  };
}

/** A record from `/portal/export`. */
export function fromExportRecord(raw) {
  const network = {};
  for (const level of LEVELS) network[level.key] = nodeRef(raw.hierarchy?.[level.exportKey]);
  if (!network.transformer.code && raw.dtCode) network.transformer.code = clean(raw.dtCode);
  const lat = toNumber(raw.geo?.lat);
  const lng = toNumber(raw.geo?.lng);
  return {
    ...baseMeter(raw),
    network,
    location: lat !== null && lng !== null ? { latitude: lat, longitude: lng } : null,
    dataQuality: [],
  };
}

/**
 * Fills in blank hierarchy codes/names using what the rest of the fleet says,
 * and applies the transformer register's canonical names. Mutates and returns
 * `meters`; every change is recorded on the meter's `dataQuality` list.
 *
 * Codes and names map 1:1 wherever both are present, so a blank half can be
 * recovered by majority vote over the other meters at the same level.
 */
export function repairNetworkPaths(meters, transformers = []) {
  const vote = (map, key, value) => {
    const counts = map.get(key) ?? new Map();
    counts.set(value, (counts.get(value) ?? 0) + 1);
    map.set(key, counts);
  };
  const winner = (counts) => (counts ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null);

  for (const { key } of LEVELS) {
    const nameByCode = new Map();
    const codeByName = new Map();
    for (const m of meters) {
      const n = m.network[key];
      if (n.code && n.name) {
        vote(nameByCode, n.code, n.name);
        vote(codeByName, n.name, n.code);
      }
    }
    for (const m of meters) {
      const n = m.network[key];
      if (!n.code && n.name) {
        const code = winner(codeByName.get(n.name));
        m.dataQuality.push({ field: `network.${key}.code`, issue: 'missing', original: null, resolvedTo: code });
        n.code = code;
      } else if (n.code && !n.name) {
        const name = winner(nameByCode.get(n.code));
        m.dataQuality.push({ field: `network.${key}.name`, issue: 'missing', original: null, resolvedTo: name });
        n.name = name;
      }
    }
  }

  // The transformer register (/portal/dts) is the authority for DT names.
  const registry = new Map(transformers.map((t) => [t.code, t.name]));
  for (const m of meters) {
    const t = m.network.transformer;
    const canonical = registry.get(t.code);
    if (canonical && t.name && t.name !== canonical) {
      m.dataQuality.push({
        field: 'network.transformer.name',
        issue: 'conflicts_with_transformer_register',
        original: t.name,
        resolvedTo: canonical,
      });
      t.name = canonical;
    }
  }
  return meters;
}
