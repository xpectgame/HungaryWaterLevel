'use strict';

const express = require('express');
const { buildNationalRainfall } = require('../domain/rain-national');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Rainfall, national, from baked HungaroMet (OMSZ) open data.
 *
 * This route used to fetch 47 OVF gauges from vizugy.hu live, per request. That was wrong
 * twice over: the OVF meteorological network is not national (nothing in the capital, a
 * bare Dunántúl), and a live upstream call fails whenever that host is unreachable from
 * the serverless runtime - which is exactly when the section answered "no data". The data
 * now comes from src/config/rain-omsz.json, baked on a runner from the OMSZ national daily
 * network, so the map covers the whole country and the endpoint cannot 503: nothing is
 * fetched at request time.
 *
 * The response keeps the OVF builder's shape - gauges, regions, headline, coverage, bands
 * - so the map and the section render it unchanged.
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
  // Kept though the build is cheap and the config is read once and cached: it memoises the
  // full per-window payload so a burst of viewers shares one computation.
  const rainCache = new TtlCache(CACHE_TTL_MS);

  const load = (days) => rainCache.wrap(`rainfall:${days}`, () => buildNationalRainfall(days));

  /** GET /rainfall?days=30 - how much rain fell across the country, against how much normally does. */
  router.get('/rainfall', asyncRoute(async (req, res) => {
    const { days, error } = parseWindow(req.query.days);
    if (error) return res.status(400).json({ error });
    // No try/catch around an upstream call any more: the data is baked, so the only failure
    // is a missing config, which buildNationalRainfall already returns as a renderable
    // "unavailable" document rather than a throw.
    return res.json(await withMeta(load(days), ctx));
  }));

  /** GET /rainfall/:id - one station, with its daily series. */
  router.get('/rainfall/:id', asyncRoute(async (req, res) => {
    const { days, error } = parseWindow(req.query.days);
    if (error) return res.status(400).json({ error });

    const built = load(days);
    const found = (built.gauges || []).find((g) => g.id === req.params.id);
    if (!found) {
      return res.status(404).json({ error: `Ismeretlen csapadékállomás: '${req.params.id}'` });
    }
    return res.json(await withMeta(found, ctx));
  }));

  return router;
};

module.exports.WINDOWS = WINDOWS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
