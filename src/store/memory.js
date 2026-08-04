'use strict';

/**
 * In-memory store with the same interface as the SQLite one.
 *
 * Exists for serverless deployment, where there is no persistent disk and no
 * long-running poller: each function instance holds whatever it has fetched itself and
 * loses it when the instance is recycled. That trade is deliberate and its consequences
 * are honest ones - the history endpoints return whatever short window this instance
 * happens to hold, and `method=lagged` degrades to `instant` because there is no
 * four-day history to look back into. Both already report that themselves.
 *
 * Also used by the tests, which want a store with no file to clean up.
 */

const DEFAULT_MAX_SAMPLES = 500;

class MemoryStore {
  constructor({ maxSamplesPerStation = DEFAULT_MAX_SAMPLES } = {}) {
    this.maxSamples = maxSamplesPerStation;
    this.readings = new Map(); // stationId -> [{ts, ...}] ascending
    this.generation = []; // [{ts, generationMw, source}] ascending
    this.balances = []; // [{ts, payload}] ascending
    this.polls = [];
    this.availability = null;
    this.path = ':memory:';
  }

  // --- station readings ----------------------------------------------------

  putStationReadings(readings) {
    let count = 0;
    for (const reading of Object.values(readings || {})) {
      if (!reading || !reading.stationId) continue;
      const ts = toMillis(reading.timestamp);
      if (!Number.isFinite(ts)) continue;

      const list = this.readings.get(reading.stationId) || [];
      const existing = list.findIndex((r) => r.ts === ts);
      const row = {
        ts,
        stationId: reading.stationId,
        timestamp: new Date(ts).toISOString(),
        flowM3s: numOrNull(reading.flowM3s),
        waterLevelCm: numOrNull(reading.waterLevelCm),
        waterTempC: numOrNull(reading.waterTempC),
        source: reading.source || null,
        quality: reading.quality || null,
      };

      if (existing >= 0) list[existing] = row;
      else insertSorted(list, row);

      // Bounded buffer - a serverless instance must not grow without limit.
      if (list.length > this.maxSamples) list.splice(0, list.length - this.maxSamples);
      this.readings.set(reading.stationId, list);
      count += 1;
    }
    return count;
  }

  latestReadings(maxAgeMs = null) {
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const out = {};
    for (const [stationId, list] of this.readings.entries()) {
      const latest = list[list.length - 1];
      if (!latest) continue;
      if (cutoff && latest.ts < cutoff) continue;
      out[stationId] = stripTs(latest);
    }
    return out;
  }

  readingAt(stationId, atMs, toleranceMs = 3 * 3600 * 1000) {
    const list = this.readings.get(stationId);
    if (!list || list.length === 0) return null;

    let best = null;
    let bestDistance = Infinity;
    for (const row of list) {
      const distance = Math.abs(row.ts - atMs);
      if (distance <= toleranceMs && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    return best ? stripTs(best) : null;
  }

  stationSeries(stationId, fromMs, toMs, limit = 5000) {
    const list = this.readings.get(stationId) || [];
    return list.filter((r) => r.ts >= fromMs && r.ts <= toMs).slice(0, limit).map(stripTs);
  }

  // --- generation ----------------------------------------------------------

  putGeneration(gen) {
    const ts = toMillis(gen.timestamp || gen.fetchedAt);
    if (!Number.isFinite(ts)) return false;

    const row = { ts, generationMw: gen.generationMw || {}, source: gen.source || null };
    const existing = this.generation.findIndex((g) => g.ts === ts);
    if (existing >= 0) this.generation[existing] = row;
    else insertSorted(this.generation, row);

    if (this.generation.length > this.maxSamples) {
      this.generation.splice(0, this.generation.length - this.maxSamples);
    }
    return true;
  }

  latestGeneration(maxAgeMs = null) {
    const latest = this.generation[this.generation.length - 1];
    if (!latest) return null;
    if (maxAgeMs && latest.ts < Date.now() - maxAgeMs) return null;
    return {
      timestamp: new Date(latest.ts).toISOString(),
      source: latest.source,
      generationMw: latest.generationMw,
    };
  }

  generationSeries(fromMs, toMs, limit = 5000) {
    return this.generation
      .filter((g) => g.ts >= fromMs && g.ts <= toMs)
      .slice(0, limit)
      .map((g) => ({
        timestamp: new Date(g.ts).toISOString(),
        source: g.source,
        generationMw: g.generationMw,
      }));
  }

  // --- unit availability ---------------------------------------------------

  putAvailability(record) {
    this.availability = { ts: Date.now(), record };
    return true;
  }

  latestAvailability(maxAgeMs = null) {
    if (!this.availability) return null;
    if (maxAgeMs && this.availability.ts < Date.now() - maxAgeMs) return null;
    return this.availability.record;
  }

  // --- balance snapshots ---------------------------------------------------

  putBalance(balance) {
    const ts = toMillis(balance.timestamp);
    if (!Number.isFinite(ts)) return false;

    const row = { ts, payload: balance };
    const existing = this.balances.findIndex((b) => b.ts === ts);
    if (existing >= 0) this.balances[existing] = row;
    else insertSorted(this.balances, row);

    if (this.balances.length > this.maxSamples) {
      this.balances.splice(0, this.balances.length - this.maxSamples);
    }
    return true;
  }

  latestBalance() {
    const latest = this.balances[this.balances.length - 1];
    return latest ? latest.payload : null;
  }

  balanceSeries(fromMs, toMs, limit = 5000) {
    return this.balances
      .filter((b) => b.ts >= fromMs && b.ts <= toMs)
      .slice(0, limit)
      .map((b) => ({
        timestamp: new Date(b.ts).toISOString(),
        netM3s: b.payload.net.m3s,
        inflowM3s: b.payload.inflow.totalM3s,
        outflowM3s: b.payload.outflow.totalM3s,
      }));
  }

  // --- housekeeping --------------------------------------------------------

  logPoll(ok, detail) {
    this.polls.push({ ts: Date.now(), ok: !!ok, detail: detail || null });
    if (this.polls.length > 50) this.polls.shift();
  }

  lastPoll() {
    const latest = this.polls[this.polls.length - 1];
    if (!latest) return null;
    return { timestamp: new Date(latest.ts).toISOString(), ok: latest.ok, detail: latest.detail };
  }

  prune() {
    // The buffers are already bounded by maxSamples; nothing further to do.
    return 0;
  }

  stats() {
    let readingCount = 0;
    let oldest = Infinity;
    let newest = -Infinity;
    for (const list of this.readings.values()) {
      readingCount += list.length;
      if (list.length > 0) {
        oldest = Math.min(oldest, list[0].ts);
        newest = Math.max(newest, list[list.length - 1].ts);
      }
    }
    return {
      path: ':memory:',
      persistent: false,
      stationReadings: readingCount,
      generationRows: this.generation.length,
      balanceSnapshots: this.balances.length,
      oldestReading: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
      newestReading: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    };
  }

  close() {
    this.readings.clear();
    this.generation.length = 0;
    this.balances.length = 0;
  }
}

/** Keep arrays ascending by ts without re-sorting the whole thing each insert. */
function insertSorted(list, row) {
  if (list.length === 0 || row.ts >= list[list.length - 1].ts) {
    list.push(row);
    return;
  }
  const index = list.findIndex((r) => r.ts > row.ts);
  list.splice(index, 0, row);
}

function stripTs(row) {
  const { ts, ...rest } = row;
  return rest;
}

function toMillis(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

module.exports = { MemoryStore };
