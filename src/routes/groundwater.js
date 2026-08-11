'use strict';

const express = require('express');
const { assess } = require('../domain/groundwater');
const { getWell } = require('../config/wells');
const { TtlCache } = require('../lib/cache');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Groundwater gets the longest cache in the project.
 *
 * An hour, against rainfall's thirty minutes and everything else's sixty seconds. The
 * network behind it reports a few times a day at best and much of it is read fortnightly,
 * so an hour cannot show anyone a number meaningfully staler than the instrument. The
 * call is 106 series in one request against someone else's public service, and paying it
 * per viewer would be indefensible for a quantity that moves centimetres a month.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

module.exports = function groundwaterRoutes(ctx) {
  const router = express.Router();
  const cache = new TtlCache(CACHE_TTL_MS);

  // Resolved once at mount, for the reason the rainfall route gives: the test suite runs
  // the whole app under the fixture provider, and a route that quietly dialled out would
  // make every test depend on an upstream being up.
  const fetchWells =
    ctx.fetchWells ||
    (ctx.config.provider === 'fixture'
      ? require('../sources/fixture').fetchWells
      : require('../sources/vizugy-wells').fetchWells);

  async function load() {
    return cache.wrapAsync('groundwater', async () => {
      const raw = await fetchWells({});
      const out = assess(raw.wells);
      return {
        ...out,
        source: raw.source,
        synthetic: raw.synthetic || undefined,
        fetchedAt: raw.fetchedAt,
        windowDays: raw.windowDays,
        // Wells that returned nothing at all, kept apart from wells that returned
        // something unusable. Both shrink the denominator and only one of them is the
        // upstream having changed.
        upstreamErrors: raw.errors.length,
      };
    });
  }

  /** GET /groundwater - every well, ranked against its own ten-year record. */
  router.get('/groundwater', asyncRoute(async (req, res) => {
    try {
      return res.json(await withMeta(await load(), ctx));
    } catch (err) {
      // Answering with a renderable "no data" document rather than throwing: the page
      // draws this as a section, and a section that throws takes the whole page with it.
      return res.status(503).json({
        error: 'groundwater upstream unavailable',
        detail: err.message,
        wells: [],
        summary: { registered: 0, comparable: 0, low: 0, veryLow: 0, recordLow: 0, high: 0 },
      });
    }
  }));

  /** GET /groundwater/:id - one well, with the record it is being judged against. */
  router.get('/groundwater/:id', asyncRoute(async (req, res) => {
    const well = getWell(req.params.id);
    if (!well) return res.status(404).json({ error: 'unknown well' });

    const document = require('../domain/flow-history').loadWellHistory();
    const record = document && document[well.id] ? document[well.id] : null;

    try {
      const all = await load();
      const current = all.wells.find((w) => w.id === well.id) || null;
      return res.json(await withMeta({
        well: {
          ...well,
          // Said plainly on the single-well response, where someone is most likely to
          // try to read the number as a measurement in a known unit.
          datumNote:
            'nptM is the well datum in metres above the Baltic. The level is a depth ' +
            "against it in this well's own unit, which is not consistent across the " +
            'network - compare it only against this well\'s own history.',
        },
        current,
        history: record ? { months: record.months, rankable: record.rankable !== false } : null,
      }, ctx));
    } catch (err) {
      return res.status(503).json({ error: 'groundwater upstream unavailable', detail: err.message });
    }
  }));

  return router;
};

module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
