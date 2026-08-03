'use strict';

/**
 * Application factories.
 *
 * Deliberately exports named factories and never a ready-made app, so tests can build
 * isolated instances with their own stores. That also means this file must never be a
 * deployment entry point: a host that loads it and looks for a default request handler
 * finds an object and refuses to boot. The entry point is server.js at the repository
 * root, and the standalone server is src/cli.js - nothing here is named `server` so
 * neither `main` nor a `start` script can accidentally aim at it.
 */

const express = require('express');
const path = require('node:path');

const { loadConfig, assertProviderSafe } = require('./config');
const { createStore } = require('./store');
const { TtlCache } = require('./lib/cache');
const { createRouter } = require('./routes');
const { createCronHandler } = require('./jobs/cron-handler');

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

  // The scheduled ingest lives inside the app rather than in a separate serverless
  // function, so it is reachable no matter how the host decides to run this project -
  // as one Node server, or as individual functions. It authenticates itself; see
  // jobs/cron-handler.js. Vercel's scheduler issues a GET.
  const cron = createCronHandler(ctx);
  app.get('/api/cron', cron);
  app.post('/api/cron', cron);

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

module.exports = { createApp, createContext };
