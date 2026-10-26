import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fromExportRecord, repairNetworkPaths } from '../src/domain/meters.js';
import { buildTree, limitDepth, summarizeConsistency } from '../src/domain/hierarchy.js';
import { buildSnapshot } from '../src/domain/catalogue.js';
import { filterMeters } from '../src/domain/query.js';
import { exportRows, transformers } from './fixtures.js';

describe('meter normalisation', () => {
  test('export records become clean, typed meters', () => {
    const m = fromExportRecord(exportRows[0]);
    assert.equal(m.status, 'decommissioned');
    assert.equal(m.installationType, 'whole_current');
    assert.equal(m.phase, 'single');
    assert.equal(m.network.transformer.code, 'DT-001');
    assert.equal(m.location.latitude, 26.938961002479868);
  });

});

describe('repairNetworkPaths', () => {
  const meters = repairNetworkPaths(exportRows.map(fromExportRecord), transformers);
  const byId = Object.fromEntries(meters.map((m) => [m.meterId, m]));

  test('recovers a blank code from the name used elsewhere', () => {
    assert.equal(byId.J100011.network.circle.code, 'C-05');
    assert.ok(byId.J100011.dataQuality.some((d) => d.field === 'network.circle.code' && d.resolvedTo === 'C-05'));
  });

  test('recovers a blank name from the code used elsewhere', () => {
    assert.equal(byId.J100011.network.feeder.name, 'Feeder 5');
  });

  test('applies the transformer register name and records the original', () => {
    assert.equal(byId.J100400.network.transformer.name, 'Malviya Nagar DT 1');
    const dq = byId.J100400.dataQuality.find((d) => d.issue === 'conflicts_with_transformer_register');
    assert.equal(dq.original, 'Old Malviya Nagar Xfmr');
  });

  test('leaves clean meters untouched', () => {
    assert.deepEqual(byId.J100000.dataQuality, []);
  });
});

describe('hierarchy', () => {
  const meters = repairNetworkPaths(exportRows.map(fromExportRecord), transformers);

  test('consistency summary counts nodes with several parents', () => {
    const division = summarizeConsistency(meters).find((c) => c.level === 'division');
    assert.deepEqual(division, { level: 'division', nodeCount: 1, nodesWithMultipleParents: 1 });
  });

  test('tree counts meters along each path and can be depth-limited', () => {
    const tree = buildTree(meters);
    assert.equal(tree.meterCount, 4);
    assert.deepEqual(tree.children.map((z) => [z.code, z.meterCount]), [['Z-01', 2], ['Z-02', 2]]);
    const shallow = limitDepth(tree, 1);
    assert.equal(shallow.children[0].children, undefined);
    assert.equal(shallow.children[0].childCount, 1);
  });
});

describe('query layer', () => {
  const snap = buildSnapshot(exportRows, transformers, 0);

  test('filters across attributes and network levels', () => {
    const rows = filterMeters(snap.meters, { status: ['installed'], network: { zone: ['z-02'] } });
    assert.deepEqual(rows.map((m) => m.meterId), ['J100011']);
  });
});
