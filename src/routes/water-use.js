'use strict';

const express = require('express');
const { buildWaterUse } = require('../domain/water-use');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * GET /vizhasznalat - what a household spends water on, and what changing it would save.
 *
 * Reads no live feed. The per-unit rates are engineering constants and the measured
 * anchor comes out of the baked sewage register, so there is nothing here that can be
 * stale - which is also why it is not cached: computing it is cheaper than checking a TTL.
 *
 * Query parameters set the model's quantities and rates, so a client can ask the server
 * the same question the page asks itself: ?shower=8&shower_rate=6&toilet=10
 */
module.exports = function waterUseRoutes(ctx) {
  const router = express.Router();

  router.get('/vizhasznalat', asyncRoute(async (req, res) => {
    const inputs = {};
    for (const [key, value] of Object.entries(req.query)) {
      const rate = key.endsWith('_rate');
      const id = rate ? key.slice(0, -5) : key;
      const n = Number(value);
      // Silently ignored rather than rejected: this endpoint's whole job is to be driven
      // from a form, and a 400 for a stray parameter would break the page over nothing.
      if (!Number.isFinite(n) || n < 0) continue;
      inputs[id] = { ...(inputs[id] || {}), [rate ? 'rate' : 'quantity']: n };
    }

    const body = buildWaterUse({ inputs });
    return res.json(await withMeta(body, ctx));
  }));

  return router;
};
