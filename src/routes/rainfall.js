'use strict';

const express = require('express');
const { buildRainfall } = require('../domain/rainfall');
const { getRainGauge } = require('../config/rain-gauges');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Rainfall gets its own cache, held far longer than the shared one.
 *
 * Most of the network reports once a day, so half an hour cannot show anyone a number
 * meaningfully staler than the instrument itself. The call behind it is a month of
 * history for 47 gauges - the most expensive request this API makes - and paying it per
 * viewer would be indefensible.
 *
 * A separate instance rather than a different TTL on the shared cache: the shared one is
 * used by every other route at sixty seconds, and temporarily raising its TTL for the
 * duration of a request would leak that TTL onto whatever else wrote to it concurrently.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * The windows offered, and why these.
 *
 * 30 days is the agricultural question - has it rained enough this month. 90 covers a
 * growing season, which is where a soil moisture deficit shows up. 7 answers "did that
 * storm actually deliver anything", which is what people ask after a loud evening.
 */
const WINDOWS = [7, 30, 90];
const DEFAULT_WINDOW = 30;

function parseWindow(raw) {
  if (raw === undefined) return { days: DEFAULT_WINDOW };
  const days = Number(raw);
  if (!Number.isInteger(days) || !WINDOWS.includes(days)) {
    return { error: `days must be one of ${WINDOWS.join(', ')}` };
  }
  return { days };
}

module.exports = function rainfallRoutes(ctx) {
  const router = express.Router();
  const rainCache = new TtlCache(CACHE_TTL_MS);

  // Resolved once at mount. Fixture mode must not reach the network - the test suite
  // runs the whole app under it, and a route that quietly dials out under a provider
  // named "fixture" would make every test depend on an upstream being up.
  const fetchRainfall =
    ctx.fetchRainfall ||
    (ctx.config.provider === 'fixture'
      ? require('../sources/fixture').fetchRainfall
      : require('../sources/vizugy-rain').fetchRainfall);

  async function load(days) {
    return rainCache.wrapAsync(`rainfall:${days}`, async () => buildRainfall(await fetchRainfall({ days })));
  }

  /** GET /rainfall?days=30 - how much rain fell, against how much normally does. */
  router.get('/rainfall', asyncRoute(async (req, res) => {
    const { days, error } = parseWindow(req.query.days);
    if (error) return res.status(400).json({ error });

    try {
      return res.json(await withMeta(await load(days), ctx));
    } catch (err) {
      // The feature is one upstream call, so a failure is total rather than partial. It
      // still has to answer with a document the map can render as "no data" - a rain
      // layer that throws takes the whole page down with it.
      return res.status(503).json(
        await withMeta(
          {
            windowDays: days,
            gauges: [],
            gaugeCount: 0,
            reportingCount: 0,
            regions: [],
            missing: [],
            unavailable: true,
            error: `csapadékadat nem érhető el: ${(err && err.message) || err}`,
          },
          ctx,
        ),
      );
    }
  }));

  /** GET /rainfall/:id - one gauge, with its daily series. */
  router.get('/rainfall/:id', asyncRoute(async (req, res) => {
    const gauge = getRainGauge(req.params.id);
    if (!gauge) return res.status(404).json({ error: `Unknown rain gauge '${req.params.id}'` });

    const { days, error } = parseWindow(req.query.days);
    if (error) return res.status(400).json({ error });

    const built = await load(days);
    const found = (built.gauges || []).find((g) => g.id === gauge.id);
    if (!found) {
      return res.status(404).json({ error: `'${gauge.id}' nem jelentett az elmúlt ${days} napban` });
    }
    return res.json(await withMeta(found, ctx));
  }));

  return router;
};

module.exports.WINDOWS = WINDOWS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
