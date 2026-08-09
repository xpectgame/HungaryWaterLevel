'use strict';

const express = require('express');
const { LAKES, getLake } = require('../config/lakes');
const { buildLakes } = require('../domain/lakes');
const { parseRange } = require('../lib/params');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/** A week of history is what the weekly trend needs; a day of it is what the daily one does. */
const HISTORY_DAYS = 8;

/**
 * Read back enough level history to say which way each lake is going.
 *
 * One query per lake rather than one for all of them, because the store's series API is
 * per-station. Three or four small queries against an indexed table is not the cost that
 * matters here, and the alternative is a store method that exists only for this route.
 */
async function loadHistory(store, ids) {
  const from = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      out[id] = await store.stationSeries(id, from, Date.now(), 2000);
    }),
  );
  return out;
}

module.exports = function lakeRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  /** GET /lakes - every lake, with its level, its trend and what that is in water. */
  router.get('/lakes', asyncRoute(async (req, res) => {
    const readings = await store.latestReadings(config.maxReadingAgeMs);
    const history = await loadHistory(store, LAKES.map((l) => l.id));
    return res.json(await withMeta(buildLakes(readings, history), ctx));
  }));

  /** GET /lakes/:id */
  router.get('/lakes/:id', asyncRoute(async (req, res) => {
    const lake = getLake(req.params.id);
    if (!lake) return res.status(404).json({ error: `Unknown lake '${req.params.id}'` });

    const readings = await store.latestReadings(config.maxReadingAgeMs);
    const history = await loadHistory(store, [lake.id]);
    const built = buildLakes(readings, history);
    return res.json(await withMeta(built.lakes.find((l) => l.id === lake.id), ctx));
  }));

  /** GET /lakes/:id/timeseries?from=&to=&limit= - the level curve. */
  router.get('/lakes/:id/timeseries', asyncRoute(async (req, res) => {
    const lake = getLake(req.params.id);
    if (!lake) return res.status(404).json({ error: `Unknown lake '${req.params.id}'` });

    const { fromMs, toMs, limit, error } = parseRange(req.query, { defaultDays: 7 });
    if (error) return res.status(400).json({ error });

    const series = await store.stationSeries(lake.id, fromMs, toMs, limit);
    return res.json(
      await withMeta(
        {
          lake: { id: lake.id, name: lake.name, gauge: lake.gauge },
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          count: series.length,
          series: series.map((r) => ({
            timestamp: r.timestamp,
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
