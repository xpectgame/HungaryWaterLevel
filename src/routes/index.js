'use strict';

const express = require('express');

const balanceRoutes = require('./balance');
const stationRoutes = require('./stations');
const lakeRoutes = require('./lakes');
const rainfallRoutes = require('./rainfall');
const eventRoutes = require('./events');
const alertRoutes = require('./alerts');
const plantRoutes = require('./powerplants');
const geoRoutes = require('./geo');
const metaRoutes = require('./meta');
const { refreshMiddleware } = require('../lib/refresh');

/**
 * Mounts the v1 API.
 *
 * Versioned from day one because the response shape is a contract with a frontend that
 * will outlive this file, and because at least one field here - the per-plant split of
 * the gas fleet - is expected to change once better dispatch data is available.
 */
function createRouter(ctx) {
  const router = express.Router();

  // No-op when a background poller is keeping the store warm; on serverless this is
  // what actually fetches the data.
  if (ctx.config.lazyRefresh) {
    router.use(refreshMiddleware(ctx));
  }

  router.use(balanceRoutes(ctx));
  router.use(stationRoutes(ctx));
  router.use(lakeRoutes(ctx));
  router.use(rainfallRoutes(ctx));
  router.use(eventRoutes(ctx));
  router.use(alertRoutes(ctx));
  router.use(plantRoutes(ctx));
  router.use(geoRoutes(ctx));
  router.use(metaRoutes(ctx));

  return router;
}

module.exports = { createRouter };
