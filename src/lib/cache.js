'use strict';

/**
 * Tiny TTL cache for computed responses.
 *
 * The underlying data only changes every 15 minutes, but a map frontend with a few
 * hundred viewers will happily ask for /snapshot every few seconds. Recomputing the
 * balance and the cooling model per request is pure waste, and the TTL is short enough
 * that nobody sees a stale number for longer than they would have anyway.
 */
class TtlCache {
  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  wrap(key, producer) {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = producer();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /** Called after a poll writes new data, so the next request recomputes immediately. */
  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { TtlCache };
