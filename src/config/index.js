'use strict';

const path = require('node:path');

/**
 * Runtime configuration. Everything is env-driven so the same build runs in dev with
 * synthetic data and in production against the live services.
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const provider = env.DATA_PROVIDER || (nodeEnv === 'production' ? 'live' : 'fixture');

  // Serverless platforms give no persistent disk and no long-running process, so the
  // store goes in memory and freshness is pulled in by the first request that notices
  // the data is old. Vercel sets VERCEL=1, so the common case needs no configuration.
  const stateless = env.STATELESS === 'true' || (!!env.VERCEL && env.STATELESS !== 'false');

  // Vercel's Postgres integrations export POSTGRES_URL; Neon and Supabase use
  // DATABASE_URL. Prefer the pooled variant when the provider offers one.
  const databaseUrl =
    env.DATABASE_URL || env.POSTGRES_URL_NON_POOLING_OVERRIDE || env.POSTGRES_URL || null;

  return {
    nodeEnv,
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',

    // 'live'    - data.vizugy.hu + MAVIR
    // 'fixture' - synthetic, for development and tests
    provider,
    allowFixtureInProduction: env.ALLOW_FIXTURE_IN_PRODUCTION === 'true',

    stateless,
    // 'sqlite'   - local file, months of history, needs a disk
    // 'memory'   - per-instance, short window, loses everything on recycle
    // 'postgres' - shared across instances; the only option that gives a serverless
    //              deployment real history AND keeps the upstream to one fetch per
    //              cron tick regardless of traffic.
    // A DATABASE_URL is taken as an explicit intent to use it.
    store: env.STORE || (databaseUrl ? 'postgres' : stateless ? 'memory' : 'sqlite'),
    databaseUrl,
    databaseSchema: env.DATABASE_SCHEMA || null,
    memoryMaxSamples: Number(env.MEMORY_MAX_SAMPLES) || 500,

    // Run the poller as a background interval (server) or on demand (serverless).
    backgroundPolling: env.BACKGROUND_POLLING ? env.BACKGROUND_POLLING === 'true' : !stateless,
    // With shared storage a cron keeps the data fresh for everyone, so requests should
    // not each try to refresh it. Without it, the request path is the only thing alive.
    lazyRefresh: env.LAZY_REFRESH ? env.LAZY_REFRESH === 'true' : stateless && !databaseUrl,
    refreshRetryMs: Number(env.REFRESH_RETRY_MS) || 60 * 1000,

    dbPath: env.DB_PATH || path.join(process.cwd(), 'data', 'hungarywaterlevel.db'),

    // MAVIR publishes on a 15-minute cadence; polling faster only adds load.
    pollIntervalMs: Number(env.POLL_INTERVAL_MS) || 15 * 60 * 1000,
    pollOnStart: env.POLL_ON_START !== 'false',

    // Beyond this age a gauge reading stops counting as live and the balance falls
    // back to climatology for that station, flagged in the response.
    maxReadingAgeMs: Number(env.MAX_READING_AGE_MS) || 6 * 3600 * 1000,

    // Must exceed the longest travel time in the station registry (~200 h) for the
    // lagged balance to have anything to look up.
    retentionDays: Number(env.RETENTION_DAYS) || 400,

    defaultBalanceMethod: env.DEFAULT_BALANCE_METHOD === 'lagged' ? 'lagged' : 'instant',
    defaultCoolingModel: env.DEFAULT_COOLING_MODEL === 'thermal' ? 'thermal' : 'linear',

    // Shared secret for the cron endpoint. Vercel sends it as `Authorization: Bearer`.
    cronSecret: env.CRON_SECRET || null,

    cacheTtlMs: Number(env.CACHE_TTL_MS) || 60 * 1000,
    corsOrigin: env.CORS_ORIGIN || '*',
    serveFrontend: env.SERVE_FRONTEND !== 'false',
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
