// The meter catalogue: every meter and the network hierarchy, held in
// memory and refreshed from the portal's bulk export.
//
// Freshness policy (stale-while-revalidate):
//   age < ttl            -> serve the snapshot as-is
//   ttl <= age < maxStale -> serve it, and refresh in the background
//   age >= maxStale       -> block on a refresh; fail if the portal is down
// Master data (which meter sits on which transformer) changes slowly, and a
// refresh costs ~4 portal requests, so a 15-minute TTL is a cheap default.

import { fromExportRecord, repairNetworkPaths } from './meters.js';
import { buildTree, summarizeConsistency } from './hierarchy.js';

export class MeterCatalogue {
  constructor({ client, ttlMs, maxStaleMs, now = Date.now, logger = console }) {
    this.client = client;
    this.ttlMs = ttlMs;
    this.maxStaleMs = maxStaleMs;
    this.now = now;
    this.logger = logger;
    this.snapshot = null;
    this.refreshing = null;
  }

  async get() {
    const age = this.snapshot ? this.now() - this.snapshot.fetchedAt : Infinity;
    if (age >= this.maxStaleMs) return this.refresh();
    if (age >= this.ttlMs) {
      this.refresh().catch((err) => this.logger.warn?.(`[catalogue] background refresh failed: ${err.message}`));
    }
    return this.snapshot;
  }

  /** Single-flight refresh. */
  refresh() {
    this.refreshing ??= this.#load()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  meta(snapshot = this.snapshot) {
    if (!snapshot) return { source: 'portal', fetchedAt: null, ageSeconds: null, stale: true };
    const age = this.now() - snapshot.fetchedAt;
    return {
      source: 'catalogue-cache',
      fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
      ageSeconds: Math.round(age / 1000),
      stale: age >= this.ttlMs,
    };
  }

  async #load() {
    const started = this.now();
    const [exported, rawTransformers] = await Promise.all([
      this.client.exportMeters(),
      this.client.listAllTransformers(),
    ]);
    const snap = buildSnapshot(exported.data, rawTransformers, this.now());
    this.logger.info?.(`[catalogue] loaded ${snap.meters.length} meters in ${this.now() - started}ms`);
    return snap;
  }
}

/** Pure: raw portal payloads -> indexed snapshot. Exported for tests. */
export function buildSnapshot(exportRows, rawTransformers, fetchedAt) {
  // The transformer register (/portal/dts) is only used as the authority for DT names.
  const registry = rawTransformers.map((t) => ({ code: String(t.code).trim(), name: String(t.name ?? '').trim() || null }));
  const meters = repairNetworkPaths(exportRows.map(fromExportRecord), registry);
  meters.sort((a, b) => a.meterId.localeCompare(b.meterId, 'en', { numeric: true }));
  return {
    fetchedAt,
    meters,
    byId: new Map(meters.map((m) => [m.meterId.toUpperCase(), m])),
    tree: buildTree(meters),
    consistency: summarizeConsistency(meters),
  };
}
