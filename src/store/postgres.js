'use strict';

const { Pool } = require('pg');

/**
 * Postgres store - shared state for serverless deployments.
 *
 * The reason this exists is not really history. It is that a serverless deployment with
 * only per-instance memory hits the upstream once per cold instance, and data.vizugy.hu
 * is a free public service run by a government agency. Under traffic that becomes
 * hundreds of requests an hour against ~30 stations, which is how you get rate-limited
 * and deserve it. With shared state plus a cron, the upstream sees exactly one fetch per
 * interval no matter how many people are watching.
 *
 * History and the lagged balance come along for free.
 *
 * ---------------------------------------------------------------------------
 * CONNECTIONS
 * ---------------------------------------------------------------------------
 * Serverless functions scale horizontally, and every instance wanting its own
 * connection is the classic way to exhaust a Postgres connection limit. Two defences:
 * a pool capped at one connection per instance, and the expectation that you point
 * DATABASE_URL at the provider's POOLED endpoint (Neon's -pooler host, Supabase's
 * pgbouncer port 6543). The pooled URL is the one that matters.
 */

/**
 * Table names are qualified explicitly rather than relying on search_path.
 *
 * Connection poolers in transaction mode - Supabase's Supavisor, PgBouncer - do not
 * reliably forward the `options=-c search_path=...` startup parameter, and `SET
 * search_path` does not survive between transactions either. Either way the store would
 * silently read and write `public` instead of the configured schema. Qualifying the
 * names in the SQL is the only approach that holds under every pooler.
 */
function buildSchemaDdl(t, schema) {
  return `
${schema ? `CREATE SCHEMA IF NOT EXISTS ${schema};` : ''}

CREATE TABLE IF NOT EXISTS ${t('station_readings')} (
  station_id     TEXT NOT NULL,
  ts             BIGINT NOT NULL,
  flow_m3s       DOUBLE PRECISION,
  water_level_cm DOUBLE PRECISION,
  water_temp_c   DOUBLE PRECISION,
  source         TEXT,
  quality        TEXT,
  PRIMARY KEY (station_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_station_readings_ts ON ${t('station_readings')} (ts);
CREATE INDEX IF NOT EXISTS idx_station_readings_station_ts ON ${t('station_readings')} (station_id, ts DESC);

CREATE TABLE IF NOT EXISTS ${t('generation')} (
  ts      BIGINT PRIMARY KEY,
  payload JSONB NOT NULL,
  source  TEXT
);

CREATE TABLE IF NOT EXISTS ${t('balance_snapshots')} (
  ts          BIGINT PRIMARY KEY,
  net_m3s     DOUBLE PRECISION,
  inflow_m3s  DOUBLE PRECISION,
  outflow_m3s DOUBLE PRECISION,
  payload     JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS ${t('availability')} (
  ts      BIGINT PRIMARY KEY,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS ${t('poll_log')} (
  ts     BIGINT PRIMARY KEY,
  ok     BOOLEAN NOT NULL,
  detail JSONB
);
`;
}

/** Schema names come from configuration, never user input, but validate anyway. */
function validateSchema(schema) {
  if (!schema) return null;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid DATABASE_SCHEMA '${schema}': must be a plain SQL identifier`);
  }
  return schema;
}


class PostgresStore {
  constructor(connectionString, { max = 1, ssl, schema } = {}) {
    if (!connectionString) throw new Error('PostgresStore requires a connection string');

    // A named schema lets this project share a database with others - a free-tier
    // Postgres is usually the only one you get - and gives parallel test files their
    // own isolated tables.
    this.schema = validateSchema(schema);
    this.t = (name) => (this.schema ? `${this.schema}.${name}` : name);

    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      // Managed providers terminate TLS with their own chain; local development does
      // not use TLS at all.
      ssl: ssl ?? (/\blocalhost\b|\b127\.0\.0\.1\b|sslmode=disable/.test(connectionString)
        ? false
        : { rejectUnauthorized: false }),
    });

    this.path = redact(connectionString);
    this.ready = null;
  }

  /**
   * Create the schema on first use.
   *
   * Idempotent and lazy rather than a migration step, because a serverless deployment
   * has no deploy hook to run one in. The promise is memoised so concurrent cold
   * requests issue the DDL once.
   */
  async init() {
    if (!this.ready) {
      this.ready = this.pool.query(buildSchemaDdl(this.t, this.schema)).catch((err) => {
        // Let the next call retry rather than caching a failure forever.
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async query(text, params) {
    await this.init();
    return this.pool.query(text, params);
  }

  // --- station readings ----------------------------------------------------

  async putStationReadings(readings) {
    const rows = Object.values(readings || {})
      .filter((r) => r && r.stationId && Number.isFinite(toMillis(r.timestamp)))
      .map((r) => [
        r.stationId,
        toMillis(r.timestamp),
        numOrNull(r.flowM3s),
        numOrNull(r.waterLevelCm),
        numOrNull(r.waterTempC),
        r.source || null,
        r.quality || null,
      ]);

    if (rows.length === 0) return 0;

    // One multi-row upsert rather than a statement per station: 30 round trips to a
    // remote database would dominate the whole poll cycle.
    const values = rows
      .map((_, i) => `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`)
      .join(',');

    await this.query(
      `INSERT INTO ${this.t('station_readings')}
         (station_id, ts, flow_m3s, water_level_cm, water_temp_c, source, quality)
       VALUES ${values}
       ON CONFLICT (station_id, ts) DO UPDATE SET
         flow_m3s = EXCLUDED.flow_m3s,
         water_level_cm = EXCLUDED.water_level_cm,
         water_temp_c = EXCLUDED.water_temp_c,
         source = EXCLUDED.source,
         quality = EXCLUDED.quality`,
      rows.flat(),
    );

    return rows.length;
  }

  async latestReadings(maxAgeMs = null) {
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const { rows } = await this.query(
      `SELECT DISTINCT ON (station_id) *
         FROM ${this.t('station_readings')}
        WHERE ($1::bigint IS NULL OR ts >= $1)
        ORDER BY station_id, ts DESC`,
      [cutoff],
    );

    const out = {};
    for (const row of rows) out[row.station_id] = rowToReading(row);
    return out;
  }

  async readingAt(stationId, atMs, toleranceMs = 3 * 3600 * 1000) {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t('station_readings')}
        WHERE station_id = $1 AND ts BETWEEN $2 AND $3
        ORDER BY ABS(ts - $4) ASC
        LIMIT 1`,
      [stationId, atMs - toleranceMs, atMs + toleranceMs, atMs],
    );
    return rows[0] ? rowToReading(rows[0]) : null;
  }

  async stationSeries(stationId, fromMs, toMs, limit = 5000) {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t('station_readings')}
        WHERE station_id = $1 AND ts BETWEEN $2 AND $3
        ORDER BY ts ASC LIMIT $4`,
      [stationId, fromMs, toMs, limit],
    );
    return rows.map(rowToReading);
  }

  // --- generation ----------------------------------------------------------

  async putGeneration(gen) {
    const ts = toMillis(gen.timestamp || gen.fetchedAt);
    if (!Number.isFinite(ts)) return false;

    await this.query(
      `INSERT INTO ${this.t('generation')} (ts, payload, source) VALUES ($1, $2, $3)
       ON CONFLICT (ts) DO UPDATE SET payload = EXCLUDED.payload, source = EXCLUDED.source`,
      [ts, JSON.stringify(gen.generationMw || {}), gen.source || null],
    );
    return true;
  }

  async latestGeneration(maxAgeMs = null) {
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const { rows } = await this.query(
      `SELECT * FROM ${this.t('generation')}
        WHERE ($1::bigint IS NULL OR ts >= $1)
        ORDER BY ts DESC LIMIT 1`,
      [cutoff],
    );
    if (!rows[0]) return null;
    return {
      timestamp: new Date(Number(rows[0].ts)).toISOString(),
      source: rows[0].source,
      generationMw: rows[0].payload,
    };
  }

  async generationSeries(fromMs, toMs, limit = 5000) {
    const { rows } = await this.query(
      `SELECT * FROM ${this.t('generation')} WHERE ts BETWEEN $1 AND $2 ORDER BY ts ASC LIMIT $3`,
      [fromMs, toMs, limit],
    );
    return rows.map((row) => ({
      timestamp: new Date(Number(row.ts)).toISOString(),
      source: row.source,
      generationMw: row.payload,
    }));
  }

  // --- balance snapshots ---------------------------------------------------

  async putBalance(balance) {
    const ts = toMillis(balance.timestamp);
    if (!Number.isFinite(ts)) return false;

    await this.query(
      `INSERT INTO ${this.t('balance_snapshots')} (ts, net_m3s, inflow_m3s, outflow_m3s, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ts) DO UPDATE SET
         net_m3s = EXCLUDED.net_m3s,
         inflow_m3s = EXCLUDED.inflow_m3s,
         outflow_m3s = EXCLUDED.outflow_m3s,
         payload = EXCLUDED.payload`,
      [ts, balance.net.m3s, balance.inflow.totalM3s, balance.outflow.totalM3s, JSON.stringify(balance)],
    );
    return true;
  }

  async latestBalance() {
    const { rows } = await this.query(`SELECT payload FROM ${this.t('balance_snapshots')} ORDER BY ts DESC LIMIT 1`);
    return rows[0] ? rows[0].payload : null;
  }

  async balanceSeries(fromMs, toMs, limit = 5000) {
    const { rows } = await this.query(
      `SELECT ts, net_m3s, inflow_m3s, outflow_m3s FROM ${this.t('balance_snapshots')}
        WHERE ts BETWEEN $1 AND $2 ORDER BY ts ASC LIMIT $3`,
      [fromMs, toMs, limit],
    );
    return rows.map((row) => ({
      timestamp: new Date(Number(row.ts)).toISOString(),
      netM3s: row.net_m3s,
      inflowM3s: row.inflow_m3s,
      outflowM3s: row.outflow_m3s,
    }));
  }

  // --- unit availability ---------------------------------------------------

  async putAvailability(record) {
    await this.query(
      `INSERT INTO ${this.t('availability')} (ts, payload) VALUES ($1, $2)
       ON CONFLICT (ts) DO UPDATE SET payload = EXCLUDED.payload`,
      [Date.now(), JSON.stringify(record)],
    );
    return true;
  }

  async latestAvailability(maxAgeMs = null) {
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const { rows } = await this.query(
      `SELECT * FROM ${this.t('availability')}
        WHERE ($1::bigint IS NULL OR ts >= $1)
        ORDER BY ts DESC LIMIT 1`,
      [cutoff],
    );
    return rows[0] ? rows[0].payload : null;
  }

  // --- housekeeping --------------------------------------------------------

  async logPoll(ok, detail) {
    await this.query(
      `INSERT INTO ${this.t('poll_log')} (ts, ok, detail) VALUES ($1, $2, $3) ON CONFLICT (ts) DO NOTHING`,
      [Date.now(), !!ok, detail ? JSON.stringify(detail) : null],
    );
  }

  async lastPoll() {
    const { rows } = await this.query(`SELECT * FROM ${this.t('poll_log')} ORDER BY ts DESC LIMIT 1`);
    if (!rows[0]) return null;
    return {
      timestamp: new Date(Number(rows[0].ts)).toISOString(),
      ok: rows[0].ok,
      detail: rows[0].detail,
    };
  }

  /**
   * Delete old measurements - and by default, do not.
   *
   * 0 or less means keep everything. This used to default to 400 days, which quietly
   * made the whole project a thirteen-month window: it could say what was happening and
   * could prove nothing about what had happened. The measurements are the archive, and
   * an archive that deletes itself is a cache.
   *
   * The poll log still rolls at 30 days regardless. That is operational noise about our
   * own fetches, not a record of the rivers, and nobody will want it in 2036.
   */
  async prune(retentionDays = 0) {
    const { rowCount: logRows } = await this.query(
      `DELETE FROM ${this.t('poll_log')} WHERE ts < $1`, [Date.now() - 30 * 86400000],
    );

    if (!(retentionDays > 0)) return 0;

    const cutoff = Date.now() - retentionDays * 86400000;
    const results = await Promise.all([
      this.query(`DELETE FROM ${this.t('station_readings')} WHERE ts < $1`, [cutoff]),
      this.query(`DELETE FROM ${this.t('generation')} WHERE ts < $1`, [cutoff]),
      this.query(`DELETE FROM ${this.t('balance_snapshots')} WHERE ts < $1`, [cutoff]),
    ]);
    void logRows;
    return results.reduce((sum, r) => sum + r.rowCount, 0);
  }

  async stats() {
    const { rows } = await this.query(`
      SELECT
        (SELECT COUNT(*) FROM ${this.t('station_readings')})   AS station_readings,
        (SELECT COUNT(*) FROM ${this.t('generation')})         AS generation_rows,
        (SELECT COUNT(*) FROM ${this.t('balance_snapshots')})  AS balance_snapshots,
        (SELECT MIN(ts) FROM ${this.t('station_readings')})    AS oldest,
        (SELECT MAX(ts) FROM ${this.t('station_readings')})    AS newest
    `);
    const row = rows[0];
    return {
      path: this.path,
      persistent: true,
      stationReadings: Number(row.station_readings),
      generationRows: Number(row.generation_rows),
      balanceSnapshots: Number(row.balance_snapshots),
      oldestReading: row.oldest == null ? null : new Date(Number(row.oldest)).toISOString(),
      newestReading: row.newest == null ? null : new Date(Number(row.newest)).toISOString(),
    };
  }

  async close() {
    await this.pool.end();
  }
}

function rowToReading(row) {
  return {
    stationId: row.station_id,
    timestamp: new Date(Number(row.ts)).toISOString(),
    flowM3s: row.flow_m3s,
    waterLevelCm: row.water_level_cm,
    waterTempC: row.water_temp_c,
    source: row.source,
    quality: row.quality,
  };
}

/** Never let a password reach a /health response. */
function redact(connectionString) {
  try {
    const url = new URL(connectionString);
    return `postgres://${url.username ? `${url.username}@` : ''}${url.host}${url.pathname}`;
  } catch {
    return 'postgres';
  }
}

function toMillis(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

module.exports = { PostgresStore };
