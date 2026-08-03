'use strict';

/**
 * Tiny TTL cache for computed responses.
 *
 * The underlying data only changes every 15 minutes, but a map frontend with a few
 * hundred viewers will happily ask for /snapshot every few seconds. Recomputing the
 * balance and the cooling model per request is pure waste, and the TTL is short enough
 * that nobody sees a stale number for longer than they would have anyway.
 *
 * Producers may be sync or async. Async ones are deduplicated while in flight, so a
 * burst of concurrent requests on a cold instance triggers one database round trip
 * rather than one per request - the same reason the refresher shares its fetch.
 */
class TtlCache {
  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.inFlight = new Map();
  }

  /** Synchronous wrap. Only valid when `producer` returns a plain value. */
  wrap(key, producer) {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const value = producer();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /** Async-aware wrap; also accepts a sync producer. */
  async wrapAsync(key, producer) {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => producer())()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
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
