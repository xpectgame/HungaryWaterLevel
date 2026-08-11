'use strict';

const express = require('express');
const { listStations, getStation, UNGAUGED_INFLOW } = require('../config/stations');
const { describeStage } = require('../domain/stage');
const { rankFlow, loadHistory, findAnalogues, QUANTILES } = require('../domain/flow-history');
const { parseRange, toCsv } = require('../lib/params');
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
    const reading = readings[station.id];
    const body = decorate(station, reading);
    // Only on the single-station response, never on the list: this is a paragraph's
    // worth of context for a gauge someone opened, and thirty copies of it would triple
    // the payload the map polls every cycle for something the map never shows.
    body.analogues = reading && Number.isFinite(reading.flowM3s)
      ? findAnalogues(station.id, reading.flowM3s, { at: reading.timestamp })
      : null;
    return res.json(await withMeta(body, ctx));
  }));

  /** GET /stations/:id/timeseries?days=|from=&to=&limit=&format=csv */
  router.get('/stations/:id/timeseries', asyncRoute(async (req, res) => {
    const station = getStation(req.params.id);
    if (!station) return res.status(404).json({ error: `Unknown station '${req.params.id}'` });

    const { fromMs, toMs, limit, error } = parseRange(req.query, { defaultDays: 7 });
    if (error) return res.status(400).json({ error });

    const series = await store.stationSeries(station.id, fromMs, toMs, limit);

    // CSV is what a newsroom actually opens. The station id and name are repeated on
    // every row rather than put in a header comment, because a comment is not CSV and
    // the first thing anyone does with one of these is concatenate several.
    if (String(req.query.format).toLowerCase() === 'csv') {
      const columns = ['station_id', 'station_name', 'river', 'timestamp', 'flow_m3s', 'water_level_cm', 'water_temp_c', 'quality'];
      res.type('text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${station.id}.csv"`);
      return res.send(toCsv(columns, series.map((r) => ({
        station_id: station.id,
        station_name: station.name,
        river: station.river,
        timestamp: r.timestamp,
        flow_m3s: r.flowM3s,
        water_level_cm: r.waterLevelCm ?? null,
        water_temp_c: r.waterTempC ?? null,
        quality: r.quality,
      }))));
    }
    return res.json(
      await withMeta(
        {
          station: { id: station.id, name: station.name, river: station.river, role: station.role },
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          count: series.length,
          // The ten-year envelope for every calendar month this window touches, so a
          // chart can draw the curve inside the range that is normal for the season
          // rather than against a single flat annual line. Keyed by month so a window
          // crossing a boundary steps where the seasons do, instead of smoothing over
          // the one place the reference genuinely changes.
          bands: bandsFor(station.id, fromMs, toMs),
          series: series.map((r) => ({
            timestamp: r.timestamp,
            flowM3s: r.flowM3s,
            waterLevelCm: r.waterLevelCm ?? null,
            waterTempC: r.waterTempC ?? null,
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
          // Water temperature, published by OVF all along and never asked for. A climate
          // signal on its own; the control on dissolved oxygen and fish kills; and the
          // reason a power plant throttles in a hot summer, because its discharge
          // temperature is capped by permit. Null where the gauge has no thermometer.
          waterTempC: Number.isFinite(reading.waterTempC) ? reading.waterTempC : null,
          // Where this sits in ten years of the same calendar month. `ratioToMean` above
          // says 73% of normal; it cannot say whether 73% is an ordinary August here or
          // the lowest in the record, and those are different stories. Null when the
          // decade has not been baked for this station and month - see domain/flow-history.
          history: rankFlow(station.id, reading.flowM3s, { at: reading.timestamp }),
        }
      : null,
  };
}

/**
 * The percentile envelope for each calendar month a time window covers.
 *
 * Returns `{ "8": { p: [...], years, days }, "9": {...} }`, 1-based months, and omits
 * any month the archive has no usable record for - so a consumer draws a band where
 * there is one and nothing where there is not, rather than a band that quietly narrows
 * to a line.
 */
function bandsFor(stationId, fromMs, toMs) {
  const document = loadHistory();
  const entry = document && document[stationId];
  if (!entry || !Array.isArray(entry.months)) return null;

  const bands = {};
  // Step a day at a time: a window is at most a few weeks here, and walking it is the
  // one way to get exactly the months it touches without special-casing year rollover.
  const DAY = 86400000;
  for (let t = fromMs; t <= toMs + DAY; t += DAY) {
    const month = new Date(t).getUTCMonth();
    const record = entry.months[month];
    if (!record || bands[month + 1]) continue;
    bands[month + 1] = { p: record.p, years: record.years, days: record.days };
  }
  return {
    quantiles: QUANTILES,
    unit: entry.unit || 'm3s',
    byMonth: bands,
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
