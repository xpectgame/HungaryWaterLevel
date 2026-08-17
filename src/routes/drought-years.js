'use strict';

const express = require('express');
const { buildDroughtYears } = require('../domain/drought-years');
const { asyncRoute } = require('../lib/async-route');

/**
 * /api/v1/aszalyevek - one calendar month, every year in the archive, per gauge.
 *
 * Reads only a baked document, so it never touches the poller and can be cached hard.
 * The default month is the current one, which is what the front page wants; `?honap=`
 * takes 1-12 in the reader's counting rather than the zero-based month the code uses,
 * because a query string is a user interface.
 */
module.exports = function droughtYearsRoutes() {
  const router = express.Router();

  router.get('/aszalyevek', asyncRoute(async (req, res) => {
    const raw = req.query.honap;
    let month;
    if (raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 12) {
        return res.status(400).json({ available: false, reason: 'A honap 1 és 12 közötti egész.' });
      }
      month = n - 1;
    }

    const reference = req.query.ev !== undefined ? Number(req.query.ev) : undefined;
    if (reference !== undefined && !Number.isInteger(reference)) {
      return res.status(400).json({ available: false, reason: 'Az ev egész évszám.' });
    }

    const body = buildDroughtYears({ month, reference, station: req.query.mérce || req.query.merce });
    if (!body.available) return res.status(503).json(body);

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.json(body);
  }));

  return router;
};
