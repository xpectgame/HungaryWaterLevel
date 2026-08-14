'use strict';

const express = require('express');
const { buildIndustry, byReceivingWater } = require('../domain/industry');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * GET /ipari - industrial and other non-municipal discharge points.
 *
 * Like /szennyviz this reads a baked register rather than a live feed, and unlike
 * /szennyviz it has nothing live to put beside it: with no volume on any row there is no
 * ratio to compute against what the river is carrying today. It is a map layer and a
 * count, and it says so.
 *
 * ?sector=Termálvíz, fürdővíz  filters to one sector, spelled as the register spells it
 * ?limit=                      caps the number of outfalls returned
 */
module.exports = function industryRoutes(ctx) {
  const router = express.Router();

  router.get('/ipari', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit);
    const body = buildIndustry({
      limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
      sector: req.query.sector || null,
    });
    if (!body.available) return res.status(503).json(body);

    body.byReceivingWater = byReceivingWater();
    return res.json(await withMeta(body, ctx));
  }));

  return router;
};
