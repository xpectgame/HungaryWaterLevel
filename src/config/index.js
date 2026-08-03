'use strict';

const path = require('node:path');
const { boolEnv, strEnv, numEnv } = require('../lib/env');

/**
 * Runtime configuration. Everything is env-driven so the same build runs in dev with
 * synthetic data and in production against the live services.
 *
 * Values are read through the helpers in lib/env rather than compared directly, because
 * these arrive as strings typed into a hosting dashboard: `TRUE`, `"true"` with the
 * quotes, a trailing space from a copy-paste. A strict `=== 'true'` turns each of those
 * into a silent wrong default, and for the fixture guard below, into a refusal to boot.
 */
function loadConfig(env = process.env) {
  const nodeEnv = strEnv(env.NODE_ENV, 'development');
  const provider = strEnv(env.DATA_PROVIDER) || (nodeEnv === 'production' ? 'live' : 'fixture');

  // Serverless platforms give no persistent disk and no long-running process, so the
  // store goes in memory and freshness is pulled in by the first request that notices
  // the data is old. Vercel sets VERCEL=1, so the common case needs no configuration.
  const stateless = boolEnv(env.STATELESS, !!strEnv(env.VERCEL));

  // Vercel's Postgres integrations export POSTGRES_URL; Neon and Supabase use
  // DATABASE_URL. Prefer the pooled variant when the provider offers one.
  const databaseUrl = strEnv(env.DATABASE_URL) || strEnv(env.POSTGRES_URL);

  return {
    nodeEnv,
    port: numEnv(env.PORT, 3000),
    host: strEnv(env.HOST, '0.0.0.0'),

    // 'live'    - data.vizugy.hu + MAVIR
    // 'fixture' - synthetic, for development and tests
    provider,
    allowFixtureInProduction: boolEnv(env.ALLOW_FIXTURE_IN_PRODUCTION, false),

    stateless,
    // 'sqlite'   - local file, months of history, needs a disk
    // 'memory'   - per-instance, short window, loses everything on recycle
    // 'postgres' - shared across instances; the only option that gives a serverless
    //              deployment real history AND keeps the upstream to one fetch per
    //              cron tick regardless of traffic.
    // A DATABASE_URL is taken as an explicit intent to use it.
    store: strEnv(env.STORE) || (databaseUrl ? 'postgres' : stateless ? 'memory' : 'sqlite'),
    databaseUrl,
    databaseSchema: strEnv(env.DATABASE_SCHEMA),
    memoryMaxSamples: numEnv(env.MEMORY_MAX_SAMPLES, 500),

    // Run the poller as a background interval (server) or on demand (serverless).
    backgroundPolling: boolEnv(env.BACKGROUND_POLLING, !stateless),
    // With shared storage a cron keeps the data fresh for everyone, so requests should
    // not each try to refresh it. Without it, the request path is the only thing alive.
    lazyRefresh: boolEnv(env.LAZY_REFRESH, stateless && !databaseUrl),
    refreshRetryMs: numEnv(env.REFRESH_RETRY_MS, 60 * 1000),

    dbPath: strEnv(env.DB_PATH) || path.join(process.cwd(), 'data', 'hungarywaterlevel.db'),

    // MAVIR publishes on a 15-minute cadence; polling faster only adds load.
    pollIntervalMs: numEnv(env.POLL_INTERVAL_MS, 15 * 60 * 1000),
    pollOnStart: boolEnv(env.POLL_ON_START, true),

    // Beyond this age a gauge reading stops counting as live and the balance falls
    // back to climatology for that station, flagged in the response.
    maxReadingAgeMs: numEnv(env.MAX_READING_AGE_MS, 6 * 3600 * 1000),

    // Must exceed the longest travel time in the station registry (~200 h) for the
    // lagged balance to have anything to look up.
    retentionDays: numEnv(env.RETENTION_DAYS, 400),

    defaultBalanceMethod: strEnv(env.DEFAULT_BALANCE_METHOD) === 'lagged' ? 'lagged' : 'instant',
    defaultCoolingModel: strEnv(env.DEFAULT_COOLING_MODEL) === 'thermal' ? 'thermal' : 'linear',

    // Shared secret for the cron endpoint. Vercel sends it as `Authorization: Bearer`.
    cronSecret: strEnv(env.CRON_SECRET),

    cacheTtlMs: numEnv(env.CACHE_TTL_MS, 60 * 1000),
    corsOrigin: strEnv(env.CORS_ORIGIN, '*'),
    serveFrontend: boolEnv(env.SERVE_FRONTEND, true),
  };
}

/**
 * Serving synthetic hydrology from something that looks like a production API is the
 * one genuinely dangerous failure mode in this project, so it takes an explicit opt-in.
 */
function assertProviderSafe(config) {
  if (config.nodeEnv === 'production' && config.provider === 'fixture' && !config.allowFixtureInProduction) {
    throw new Error(
      'Refusing to start: DATA_PROVIDER=fixture in production would serve synthetic water data as if it were real. ' +
        'Set DATA_PROVIDER=live, or ALLOW_FIXTURE_IN_PRODUCTION=true if this is a deliberate demo deployment.',
    );
  }
}

module.exports = { loadConfig, assertProviderSafe };
