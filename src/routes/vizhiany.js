'use strict';

const express = require('express');
const { assessVizhiany } = require('../domain/vizhiany');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * An hour.
 *
 * A water-shortage declaration is a legal act with a signature behind it, not a
 * telemetered number. Across the 85 districts the observed record showed twelve distinct
 * update timestamps - so the thing changes a few times a week, not a few times an hour,
 * and asking someone else's map server on every page load would be paying for nothing.
 *
 * An hour rather than a day because the direction of travel matters: when a district is
 * raised to the extraordinary grade, a site that keeps saying III. fok until tomorrow is
 * wrong about the one thing it was built to be right about.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

module.exports = function vizhianyRoutes(ctx) {
  const router = express.Router();
  const cache = new TtlCache(CACHE_TTL_MS);

  const fetchVizhiany =
    ctx.fetchVizhiany ||
    (ctx.config.provider === 'fixture'
      ? require('../sources/fixture').fetchVizhiany
      : require('../sources/vizhiany').fetchVizhiany);

  router.get('/vizhiany', asyncRoute(async (req, res) => {
    const body = await cache.wrapAsync('vizhiany', async () => {
      const raw = await fetchVizhiany({});
      return assessVizhiany(raw);
    });

    // 503 rather than an empty document: an absent drought declaration and a declaration
    // of "no drought" are opposite statements, and a consumer must not be able to read
    // one as the other.
    if (!body.available) {
      return res.status(503).json({
        available: false,
        reason: 'a vízhiány-fokozatok most nem érhetők el a vízügyi geoportálról',
      });
    }

    return res.json(await withMeta(body, ctx));
  }));

  return router;
};
