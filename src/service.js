// Use-case layer: what each API endpoint actually needs, built from the
// catalogue (cached master data) and the portal client (live consumption).

import { TtlCache } from './util/ttlCache.js';
import { addDays, buildConsumption, istDayStart } from './domain/consumption.js';
import { LEVEL_KEYS } from './domain/meters.js';
import { limitDepth } from './domain/hierarchy.js';
import { filterMeters, paginate } from './domain/query.js';
import { PortalNotFoundError } from './portal/errors.js';

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.code = 'not_found';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_WINDOW_TTL_MS = DAY_MS;

export function presentMeter(m) {
  return {
    meterId: m.meterId,
    serialNumber: m.serialNumber,
    make: m.make,
    phase: m.phase,
    status: m.status,
    installationType: m.installationType,
    network: m.network,
    location: m.location,
    dataQuality: m.dataQuality,
  };
}

export class MeterService {
  constructor({ client, catalogue, consumptionTtlMs, consumptionMaxEntries = 500, now = Date.now }) {
    this.client = client;
    this.catalogue = catalogue;
    this.consumptionTtlMs = consumptionTtlMs;
    this.now = now;
    this.consumptionCache = new TtlCache({ maxEntries: consumptionMaxEntries, now });
  }

  async listMeters(filters, { page, pageSize }) {
    const snap = await this.catalogue.get();
    const result = paginate(filterMeters(snap.meters, filters), page, pageSize);
    return { data: result.data.map(presentMeter), pagination: result.pagination, meta: this.catalogue.meta(snap) };
  }

  async getMeter(meterId) {
    const snap = await this.catalogue.get();
    const meter = snap.byId.get(meterId.toUpperCase());
    if (!meter) throw new NotFoundError(`Meter ${meterId} not found`);
    return { data: presentMeter(meter), meta: this.catalogue.meta(snap) };
  }

  /**
   * @param window `{ from, to }` as YYYY-MM-DD (IST days, inclusive) or nulls for the portal default
   */
  async getConsumption(meterId, { from, to }) {
    // Resolve the meter first so unknown ids 404 without spending portal budget.
    const { data: meter } = await this.getMeter(meterId);
    const id = meter.meterId;

    const key = `${id}|${from ?? ''}|${to ?? ''}`;
    let entry = this.consumptionCache.get(key);
    let source = 'cache';
    if (!entry) {
      source = 'portal';
      // Ask for one extra day so the last requested day has its closing reading.
      const rows = await this.#fetchEnergy(id, from ? { from, to: addDays(to, 1) } : {});
      const windowEnd = to ? istDayStart(addDays(to, 1)) : null;
      // Readings for intervals that closed long ago don't change, so cache them longer.
      const ttl = windowEnd && windowEnd < this.now() - DAY_MS ? CLOSED_WINDOW_TTL_MS : this.consumptionTtlMs;
      this.consumptionCache.set(key, rows, ttl);
      entry = this.consumptionCache.get(key);
    }

    const window = from ? { startMs: istDayStart(from), endMs: istDayStart(addDays(to, 1)) } : null;
    const result = buildConsumption(entry.value, { window });
    if (meter.status === 'decommissioned' && result.totalKwh > 0) {
      result.notes.push('Meter is marked decommissioned but its kWh register advanced in this window.');
    }

    return {
      data: {
        meterId: id,
        requestedWindow: from ? { from, to } : null,
        ...result,
      },
      meta: {
        source,
        fetchedAt: new Date(entry.storedAt).toISOString(),
        cacheExpiresAt: new Date(entry.expiresAt).toISOString(),
      },
    };
  }

  async #fetchEnergy(meterId, range) {
    try {
      return await this.client.getMeterEnergy(meterId, range);
    } catch (err) {
      if (err instanceof PortalNotFoundError) throw new NotFoundError(`Meter ${meterId} not found`);
      throw err;
    }
  }

  async getHierarchy({ depth }) {
    const snap = await this.catalogue.get();
    return {
      data: {
        levels: LEVEL_KEYS,
        consistency: snap.consistency,
        tree: depth === undefined ? snap.tree : limitDepth(snap.tree, depth),
      },
      meta: this.catalogue.meta(snap),
    };
  }
}
