'use strict';

const path = require('node:path');

/**
 * Runtime configuration. Everything is env-driven so the same build runs in dev with
 * synthetic data and in production against the live services.
 */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const provider = env.DATA_PROVIDER || (nodeEnv === 'production' ? 'live' : 'fixture');

  return {
    nodeEnv,
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',

    // 'live'    - data.vizugy.hu + MAVIR
    // 'fixture' - synthetic, for development and tests
    provider,
    allowFixtureInProduction: env.ALLOW_FIXTURE_IN_PRODUCTION === 'true',

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
