// Tiny in-memory TTL cache with LRU eviction (Map preserves insertion order).

export class TtlCache {
  constructor({ maxEntries = 500, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, storedAt: this.now(), expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }
}
