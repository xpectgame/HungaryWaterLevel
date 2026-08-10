'use strict';

const express = require('express');
const { listStations, getStation, UNGAUGED_INFLOW } = require('../config/stations');
const { describeStage } = require('../domain/stage');
const { rankFlow } = require('../domain/flow-history');
const { parseRange } = require('../lib/params');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

module.exports = function stationRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  /** GET /stations?role=inflow|outflow|interior - registry plus current readings. */
  router.get('/stations', asyncRoute(async (req, res) => {
    const role = req.query.role;
    if (role && !['inflow', 'outflow', 'interior'].includes(role)) {
      return res.status(400).json({ error: `Unknown role '${role}'. Use inflow, outflow or interior.` });
    }

    const readings = await store.latestReadings(config.maxReadingAgeMs);
    const stations = listStations(role).map((station) => decorate(station, readings[station.id]));

    return res.json(
      await withMeta(
        {
          count: stations.length,
          ungaugedInflow: UNGAUGED_INFLOW,
          stations,
        },
        ctx,
      ),
    );
  }));

  /** GET /stations/:id */
  router.get('/stations/:id', asyncRoute(async (req, res) => {
    const station = getStation(req.params.id);
    if (!station) return res.status(404).json({ error: `Unknown station '${req.params.id}'` });

    const readings = await store.latestReadings(config.maxReadingAgeMs);
    return res.json(await withMeta(decorate(station, readings[station.id]), ctx));
  }));

  /** GET /stations/:id/timeseries?from=&to=&limit= */
  router.get('/stations/:id/timeseries', asyncRoute(async (req, res) => {
    const station = getStation(req.params.id);
    if (!station) return res.status(404).json({ error: `Unknown station '${req.params.id}'` });

    const { fromMs, toMs, limit, error } = parseRange(req.query, { defaultDays: 7 });
    if (error) return res.status(400).json({ error });

    const series = await store.stationSeries(station.id, fromMs, toMs, limit);
    return res.json(
      await withMeta(
        {
          station: { id: station.id, name: station.name, river: station.river, role: station.role },
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          count: series.length,
          series: series.map((r) => ({
            timestamp: r.timestamp,
            flowM3s: r.flowM3s,
            waterLevelCm: r.waterLevelCm ?? null,
            quality: r.quality,
          })),
        },
        ctx,
      ),
    );
  }));

  return router;
};

/**
 * Merge registry metadata with the latest reading.
 *
 * `current` is null rather than a substituted mean when no live reading exists: the
 * balance endpoint may fall back to climatology to keep its sum whole, but a station
 * endpoint asked about one specific gauge must say plainly that it has nothing.
 */
function decorate(station, reading) {
  return {
    id: station.id,
    name: station.name,
    river: station.river,
    role: station.role,
    countsTowardBalance: station.role === 'inflow' || station.role === 'outflow',
    redundantWith: station.redundantWith || null,
    location: { lat: station.lat, lon: station.lon },
    riverKm: station.riverKm || null,
    upstreamCountry: station.country || null,
    longTermMeanM3s: station.meanFlow,
    travelTimeToBorderHours: station.travelTimeHours ?? null,
    uncertaintyPct: station.uncertaintyPct,
    note: station.note || null,
    noteHu: station.noteHu || null,
    current: reading
      ? {
          flowM3s: reading.flowM3s,
          timestamp: reading.timestamp,
          quality: reading.quality,
          source: reading.source,
          ratioToMean: station.meanFlow > 0 ? round(reading.flowM3s / station.meanFlow, 3) : null,
          // Stage arrives from the same request as discharge but is absent more often -
          // a gauge can publish one and not the other. Null here means "not published
          // this cycle", never "zero".
          stage: describeStage(reading.waterLevelCm, station.id),
          // Where this sits in ten years of the same calendar month. `ratioToMean` above
          // says 73% of normal; it cannot say whether 73% is an ordinary August here or
          // the lowest in the record, and those are different stories. Null when the
          // decade has not been baked for this station and month - see domain/flow-history.
          history: rankFlow(station.id, reading.flowM3s, { at: reading.timestamp }),
        }
      : null,
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
