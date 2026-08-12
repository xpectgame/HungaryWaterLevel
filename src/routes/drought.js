'use strict';

const express = require('express');
const { assessDrought } = require('../domain/drought');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Half an hour, matching rainfall rather than groundwater.
 *
 * These stations report several times a day - it is a telemetered network, unlike the
 * confined-aquifer wells on their fortnightly dip-meter rounds - so an hour would be
 * showing a number staler than the instrument. It is still 770 series in one request, so
 * it is not paid per viewer either.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

module.exports = function droughtRoutes(ctx) {
  const router = express.Router();
  const cache = new TtlCache(CACHE_TTL_MS);

  const fetchShallowWells =
    ctx.fetchShallowWells ||
    (ctx.config.provider === 'fixture'
      ? require('../sources/fixture').fetchShallowWells
      : require('../sources/vizugy-wells').fetchShallowWells);

  async function load() {
    return cache.wrapAsync('drought', async () => {
      const raw = await fetchShallowWells({});
      const out = assessDrought(raw.wells);
      return {
        ...out,
        source: raw.source,
        synthetic: raw.synthetic || undefined,
        fetchedAt: raw.fetchedAt,
        upstreamErrors: raw.errors.length,
      };
    });
  }

  /** GET /drought - the shallow water table, each station against its own decade. */
  router.get('/drought', asyncRoute(async (req, res) => {
    try {
      return res.json(await withMeta(await load(), ctx));
    } catch (err) {
      return res.status(503).json({
        error: 'drought upstream unavailable',
        detail: err.message,
        stations: [],
        summary: { registered: 0, comparable: 0, dry: 0, veryDry: 0, deepestOnRecord: 0 },
      });
    }
  }));

  return router;
};

module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
