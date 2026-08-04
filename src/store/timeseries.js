'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Time-series storage, backed by SQLite through Node's built-in driver.
 *
 * SQLite rather than Postgres because the write volume is tiny and fixed: ~30 stations
 * plus one generation row every 15 minutes is under 3000 rows a day, and a single file
 * with no server to run makes this deployable anywhere. The interface below is narrow
 * on purpose, so swapping in Postgres later is a matter of reimplementing this one
 * module rather than touching the routes.
 *
 * History matters here beyond charting: the travel-time-corrected balance needs to look
 * up what the Danube was doing at Rajka four days ago, so the retention window has to
 * comfortably exceed the longest travel time in the station registry (~200 h for the
 * upper Tisza).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS station_readings (
  station_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  flow_m3s   REAL,
  water_level_cm REAL,
  water_temp_c   REAL,
  source     TEXT,
  quality    TEXT,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_station_readings_ts ON station_readings (ts);

CREATE TABLE IF NOT EXISTS generation (
  ts      INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  source  TEXT
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  ts      INTEGER PRIMARY KEY,
  net_m3s REAL,
  inflow_m3s REAL,
  outflow_m3s REAL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability (
  ts      INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_log (
  ts       INTEGER PRIMARY KEY,
  ok       INTEGER NOT NULL,
  detail   TEXT
);
`;

class TimeseriesStore {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.path = dbPath;
  }

  // --- station readings ----------------------------------------------------

  putStationReadings(readings) {
    const stmt = this.db.prepare(`
      INSERT INTO station_readings (station_id, ts, flow_m3s, water_level_cm, water_temp_c, source, quality)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (station_id, ts) DO UPDATE SET
        flow_m3s = excluded.flow_m3s,
        water_level_cm = excluded.water_level_cm,
        water_temp_c = excluded.water_temp_c,
        source = excluded.source,
        quality = excluded.quality
    `);

    let count = 0;
    for (const reading of Object.values(readings)) {
      if (!reading || !reading.stationId) continue;
      const ts = toMillis(reading.timestamp);
      if (!Number.isFinite(ts)) continue;
      stmt.run(
        reading.stationId,
        ts,
        numOrNull(reading.flowM3s),
        numOrNull(reading.waterLevelCm),
        numOrNull(reading.waterTempC),
        reading.source || null,
        reading.quality || null,
      );
      count += 1;
    }
    return count;
  }

  /** Newest reading per station, as a map keyed by station id. */
  latestReadings(maxAgeMs = null) {
    const rows = this.db
      .prepare(`
        SELECT r.* FROM station_readings r
        JOIN (SELECT station_id, MAX(ts) AS ts FROM station_readings GROUP BY station_id) m
          ON r.station_id = m.station_id AND r.ts = m.ts
      `)
      .all();

    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const out = {};
    for (const row of rows) {
      // A stale gauge is worse than a missing one - it makes the balance look live when
      // it is not - so anything past the cutoff is dropped and falls back to climatology.
      if (cutoff && row.ts < cutoff) continue;
      out[row.station_id] = rowToReading(row);
    }
    return out;
  }

  /**
   * Reading nearest to a point in time, for the travel-time-lagged balance.
   * Returns null when nothing falls inside the tolerance window.
   */
  readingAt(stationId, atMs, toleranceMs = 3 * 3600 * 1000) {
    const row = this.db
      .prepare(`
        SELECT * FROM station_readings
        WHERE station_id = ? AND ts BETWEEN ? AND ?
        ORDER BY ABS(ts - ?) ASC
        LIMIT 1
      `)
      .get(stationId, atMs - toleranceMs, atMs + toleranceMs, atMs);
    return row ? rowToReading(row) : null;
  }

  stationSeries(stationId, fromMs, toMs, limit = 5000) {
    const rows = this.db
      .prepare(`
        SELECT * FROM station_readings
        WHERE station_id = ? AND ts BETWEEN ? AND ?
        ORDER BY ts ASC LIMIT ?
      `)
      .all(stationId, fromMs, toMs, limit);
    return rows.map(rowToReading);
  }

  // --- generation ----------------------------------------------------------

  putGeneration(gen) {
    const ts = toMillis(gen.timestamp || gen.fetchedAt);
    if (!Number.isFinite(ts)) return false;
    this.db
      .prepare('INSERT INTO generation (ts, payload, source) VALUES (?, ?, ?) ON CONFLICT (ts) DO UPDATE SET payload = excluded.payload, source = excluded.source')
      .run(ts, JSON.stringify(gen.generationMw || {}), gen.source || null);
    return true;
  }

  latestGeneration(maxAgeMs = null) {
    const row = this.db.prepare('SELECT * FROM generation ORDER BY ts DESC LIMIT 1').get();
    if (!row) return null;
    if (maxAgeMs && row.ts < Date.now() - maxAgeMs) return null;
    return {
      timestamp: new Date(row.ts).toISOString(),
      source: row.source,
      generationMw: JSON.parse(row.payload),
    };
  }

  generationSeries(fromMs, toMs, limit = 5000) {
    return this.db
      .prepare('SELECT * FROM generation WHERE ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?')
      .all(fromMs, toMs, limit)
      .map((row) => ({
        timestamp: new Date(row.ts).toISOString(),
        source: row.source,
        generationMw: JSON.parse(row.payload),
      }));
  }

  // --- balance snapshots ---------------------------------------------------

  putBalance(balance) {
    const ts = toMillis(balance.timestamp);
    if (!Number.isFinite(ts)) return false;
    this.db
      .prepare(`
        INSERT INTO balance_snapshots (ts, net_m3s, inflow_m3s, outflow_m3s, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (ts) DO UPDATE SET
          net_m3s = excluded.net_m3s,
          inflow_m3s = excluded.inflow_m3s,
          outflow_m3s = excluded.outflow_m3s,
          payload = excluded.payload
      `)
      .run(ts, balance.net.m3s, balance.inflow.totalM3s, balance.outflow.totalM3s, JSON.stringify(balance));
    return true;
  }

  latestBalance() {
    const row = this.db.prepare('SELECT payload FROM balance_snapshots ORDER BY ts DESC LIMIT 1').get();
    return row ? JSON.parse(row.payload) : null;
  }

  /** Compact series for charting - avoids shipping every full snapshot. */
  balanceSeries(fromMs, toMs, limit = 5000) {
    return this.db
      .prepare(`
        SELECT ts, net_m3s, inflow_m3s, outflow_m3s FROM balance_snapshots
        WHERE ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?
      `)
      .all(fromMs, toMs, limit)
      .map((row) => ({
        timestamp: new Date(row.ts).toISOString(),
        netM3s: row.net_m3s,
        inflowM3s: row.inflow_m3s,
        outflowM3s: row.outflow_m3s,
      }));
  }

  // --- unit availability ---------------------------------------------------

  putAvailability(record) {
    this.db
      .prepare('INSERT INTO availability (ts, payload) VALUES (?, ?) ON CONFLICT (ts) DO UPDATE SET payload = excluded.payload')
      .run(Date.now(), JSON.stringify(record));
    return true;
  }

  latestAvailability(maxAgeMs = null) {
    const row = this.db.prepare('SELECT * FROM availability ORDER BY ts DESC LIMIT 1').get();
    if (!row) return null;
    if (maxAgeMs && row.ts < Date.now() - maxAgeMs) return null;
    return JSON.parse(row.payload);
  }

  // --- housekeeping --------------------------------------------------------

  logPoll(ok, detail) {
    this.db
      .prepare('INSERT INTO poll_log (ts, ok, detail) VALUES (?, ?, ?) ON CONFLICT (ts) DO NOTHING')
      .run(Date.now(), ok ? 1 : 0, detail ? JSON.stringify(detail).slice(0, 4000) : null);
  }

  lastPoll() {
    const row = this.db.prepare('SELECT * FROM poll_log ORDER BY ts DESC LIMIT 1').get();
    if (!row) return null;
    return { timestamp: new Date(row.ts).toISOString(), ok: !!row.ok, detail: row.detail ? JSON.parse(row.detail) : null };
  }

  prune(retentionDays = 400) {
    const cutoff = Date.now() - retentionDays * 86400000;
    const a = this.db.prepare('DELETE FROM station_readings WHERE ts < ?').run(cutoff);
    const b = this.db.prepare('DELETE FROM generation WHERE ts < ?').run(cutoff);
    const c = this.db.prepare('DELETE FROM balance_snapshots WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM poll_log WHERE ts < ?').run(Date.now() - 30 * 86400000);
    return a.changes + b.changes + c.changes;
  }

  stats() {
    const q = (sql) => this.db.prepare(sql).get();
    return {
      path: this.path,
      stationReadings: q('SELECT COUNT(*) AS n FROM station_readings').n,
      generationRows: q('SELECT COUNT(*) AS n FROM generation').n,
      balanceSnapshots: q('SELECT COUNT(*) AS n FROM balance_snapshots').n,
      oldestReading: nullableIso(q('SELECT MIN(ts) AS t FROM station_readings').t),
      newestReading: nullableIso(q('SELECT MAX(ts) AS t FROM station_readings').t),
    };
  }

  close() {
    this.db.close();
  }
}

function rowToReading(row) {
  return {
    stationId: row.station_id,
    timestamp: new Date(row.ts).toISOString(),
    flowM3s: row.flow_m3s,
    waterLevelCm: row.water_level_cm,
    waterTempC: row.water_temp_c,
    source: row.source,
    quality: row.quality,
  };
}

function toMillis(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

function nullableIso(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

module.exports = { TimeseriesStore };
