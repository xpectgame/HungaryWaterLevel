'use strict';

const express = require('express');
const { buildSewage, shareOfFlow } = require('../domain/sewage');
const { getStation, listStations } = require('../config/stations');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * GET /szennyviz - the treatment plants and where their water goes.
 *
 * Not cached and not fetched: unlike every other endpoint here, this reads a baked
 * register rather than a live feed. The plants do not move and their design capacity does
 * not change between page loads, so a TTL cache would be protecting nothing.
 *
 * What IS live is the comparison. Where a plant names its receiving watercourse and this
 * project has a gauge on that watercourse, the discharge is put next to what the river is
 * carrying right now - which is the whole point, because that ratio is a completely
 * different number in June and in September.
 */
module.exports = function sewageRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  router.get('/szennyviz', asyncRoute(async (req, res) => {
    const limit = Number(req.query.limit);
    const body = buildSewage({ limit: Number.isFinite(limit) && limit > 0 ? limit : 0 });
    if (!body.available) return res.status(503).json(body);

    const readings = await store.latestReadings(config.maxReadingAgeMs);
    body.byReceivingWater = body.byReceivingWater.map((g) => {
      const station = gaugeFor(g.water);
      const reading = station && readings[station.id];
      const riverM3s = reading && Number.isFinite(reading.flowM3s) ? reading.flowM3s : null;
      return {
        ...g,
        gaugedAt: station ? { id: station.id, name: station.name } : null,
        riverM3s,
        // Null, never a number, when the river's flow is unknown. See domain/sewage:
        // a zero denominator would print "the entire river is sewage".
        shareOfFlow: shareOfFlow(g.m3s, riverM3s),
      };
    });

    return res.json(await withMeta(body, ctx));
  }));

  return router;
};

// Exported for the test that pins the outflow rule: picking the first matching gauge
// compared eight Tisza plants against the inflow at the Ukrainian border.
module.exports.gaugeFor = gaugeFor;

/**
 * The gauge on a named watercourse, if this project has one - and the RIGHT gauge.
 *
 * Matched on the river name the station registry already carries, exactly, because a
 * loose match would attach a town's sewage to the wrong river and then print a ratio
 * about it. Most of the 133 named receiving waters have no gauge on this site at all -
 * the Tocó-csatorna is not a gauged river - and that is reported as no comparison rather
 * than as a comparison with something else.
 *
 * THE CROSS-SECTION MATTERS AND THE FIRST MATCH IS THE WRONG ONE. The Tisza has eight
 * plants on it and five gauges along it, and taking whichever came first in the registry
 * picked Tiszabecs - the inflow gauge at the Ukrainian border, UPSTREAM of every one of
 * those eight discharges. The ratio it produced was arithmetically fine and physically
 * meaningless: none of that sewage has entered the river at that point.
 *
 * The outflow gauge is the defensible choice. It is the section where everything upstream
 * has accumulated, so "these plants put in X, and the river leaves the country carrying
 * Y" is a true sentence about the same water. The station is named in the response so a
 * reader can see which section the comparison is against.
 */
function gaugeFor(waterName) {
  if (!waterName) return null;
  const wanted = String(waterName).trim().toLowerCase();
  const onThisWater = listStations().filter(
    (s) => String(s.river || '').trim().toLowerCase() === wanted,
  );
  if (!onThisWater.length) return null;
  return onThisWater.find((s) => s.role === 'outflow') || onThisWater[0];
}
