'use strict';

const express = require('express');

const balanceRoutes = require('./balance');
const stationRoutes = require('./stations');
const plantRoutes = require('./powerplants');
const geoRoutes = require('./geo');
const metaRoutes = require('./meta');

/**
 * Mounts the v1 API.
 *
 * Versioned from day one because the response shape is a contract with a frontend that
 * will outlive this file, and because at least one field here - the per-plant split of
 * the gas fleet - is expected to change once better dispatch data is available.
 */
function createRouter(ctx) {
  const router = express.Router();

  router.use(balanceRoutes(ctx));
  router.use(stationRoutes(ctx));
  router.use(plantRoutes(ctx));
  router.use(geoRoutes(ctx));
  router.use(metaRoutes(ctx));

  return router;
}

module.exports = { createRouter };
