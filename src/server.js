'use strict';

const express = require('express');
const path = require('node:path');

const { loadConfig, assertProviderSafe } = require('./config');
const { createStore } = require('./store');
const { TtlCache } = require('./lib/cache');
const { createRouter } = require('./routes');
const { startPolling } = require('./jobs/poll');

function createApp(ctx) {
  const app = express();
  const { config } = ctx;

  app.disable('x-powered-by');
  app.set('json spaces', 0);

  // Open data, read-only, no credentials - a permissive CORS header is the whole point.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.use('/api/v1', createRouter(ctx));

  if (config.serveFrontend) {
    app.use(express.static(path.join(__dirname, '..', 'public')));
  }

  app.get('/', (req, res) => {
    if (config.serveFrontend) return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    return res.redirect('/api/v1/health');
  });

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      hint: 'See /api/v1/health, /api/v1/snapshot, /api/v1/balance, /api/v1/stations, /api/v1/powerplants, /api/v1/meta/sources',
    });
  });

  // Anything thrown in a route lands here. The message goes to the log, not to the
  // client, since it can contain upstream URLs and internal paths.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[api] unhandled error on', req.method, req.originalUrl, '-', err.message);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

/**
 * Build the app and its dependencies without binding a port.
 * Shared by the standalone server and the serverless entry point.
 */
function createContext(env = process.env) {
  const config = loadConfig(env);
  assertProviderSafe(config);

  const store = createStore(config);
  const cache = new TtlCache(config.cacheTtlMs);

  return { config, store, cache };
}

/** The one line an operator reads to know where data lives and what keeps it fresh. */
function describeStore(config, store) {
  if (config.store === 'memory') return 'memory (no persistence)';
  if (config.store === 'postgres') return store.path;
  return config.dbPath;
}

function describeIngest(config) {
  if (config.backgroundPolling) return `background poll every ${Math.round(config.pollIntervalMs / 60000)} min`;
  if (config.lazyRefresh) return 'on demand, driven by requests';
  return 'external cron (nothing in this process fetches)';
}

function start() {
  const ctx = createContext();
  const { config, store, cache } = ctx;

  const app = createApp(ctx);

  const stopPolling = config.backgroundPolling
    ? startPolling(store, config, {
        log: (...args) => {
          console.log(...args);
          // New data invalidates every derived response.
          cache.clear();
        },
        warn: console.warn,
        error: console.error,
      })
    : () => {};

  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] HungaryWaterLevel listening on http://${config.host}:${config.port}`);
    console.log(`[api] provider=${config.provider}${config.provider === 'fixture' ? ' (SYNTHETIC DATA)' : ''}`);
    console.log(`[api] store=${describeStore(config, store)}, ingest=${describeIngest(config)}`);
  });

  const shutdown = (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    stopPolling();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, store, config };
}

if (require.main === module) {
  start();
}

module.exports = { createApp, createContext, start };
