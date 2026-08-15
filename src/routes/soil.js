'use strict';

const express = require('express');
const { buildSoil } = require('../domain/soil');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Twenty minutes.
 *
 * The stations report hourly, so anything shorter asks someone else's service the same
 * question three times for one new number. Longer would start showing a reading as
 * current when the next one has already been published - and this is a quantity that
 * moves visibly within a day after rain.
 */
const CACHE_TTL_MS = 20 * 60 * 1000;

/**
 * GET /talajnedvesseg - how wet the ground is, where it is measured.
 *
 * Outside the fifteen-minute poll for the same reason the wells are: the poll exists for
 * rivers, which can rise in an hour, and 23 hourly stations do not need 96 requests a day.
 */
module.exports = function soilRoutes(ctx) {
  const router = express.Router();
  const cache = new TtlCache(CACHE_TTL_MS);

  const fetchSoil =
    ctx.fetchSoilMoisture ||
    (ctx.config.provider === 'fixture'
      ? require('../sources/fixture').fetchSoilMoisture
      : require('../sources/vizugy-wells').fetchSoilMoisture);

  router.get('/talajnedvesseg', asyncRoute(async (req, res) => {
    let body;
    try {
      body = await cache.wrapAsync('soil', async () => {
        const raw = await fetchSoil({});
        return buildSoil(raw.wells || {});
      });
    } catch (err) {
      // Caught outside the cache, like the water-shortage route: a failure stored for
      // twenty minutes turns one bad request into twenty minutes of an empty section.
      return res.status(503).json({
        available: false,
        reason: 'a talajnedvesség-mérések most nem érhetők el',
        detail: String((err && err.message) || err).split('\n')[0].slice(0, 200),
      });
    }

    return res.json(await withMeta(body, ctx));
  }));

  return router;
};
