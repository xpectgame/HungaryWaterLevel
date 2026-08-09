'use strict';

const express = require('express');
const { buildEvents } = require('../domain/events');
const { pollableStations } = require('../config/stations');
const { LAKES } = require('../config/lakes');
const { activeNotes } = require('../config/notes');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/** Long enough for a week-long dry run to be visible, short enough to stay cheap. */
const WINDOW_DAYS = 10;

module.exports = function eventRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  /** GET /events - what happened, derived from our own series, plus any editorial notes. */
  router.get('/events', asyncRoute(async (req, res) => {
    const from = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
    const to = Date.now();

    const [readings, generationSeries, ...series] = await Promise.all([
      store.latestReadings(config.maxReadingAgeMs),
      store.generationSeries(from, to, 2000),
      ...pollableStations().map((s) => store.stationSeries(s.id, from, to, 2000)),
      ...LAKES.map((l) => store.stationSeries(l.id, from, to, 2000)),
    ]);

    const stations = pollableStations();
    const historyByStation = {};
    stations.forEach((s, i) => { historyByStation[s.id] = series[i]; });
    const lakeHistory = {};
    LAKES.forEach((l, i) => { lakeHistory[l.id] = series[stations.length + i]; });

    const built = buildEvents({ readings, historyByStation, lakeHistory, generationSeries });

    return res.json(
      await withMeta(
        {
          ...built,
          // Kept in a separate list, never merged into `events`: one is arithmetic on
          // measurements, the other is a person's claim with a link. A reader has to be
          // able to tell which is which without reading carefully.
          notes: activeNotes().map((n) => ({
            id: n.id,
            from: n.from,
            until: n.until || null,
            title: n.title,
            body: n.body,
            source: n.source,
            topics: n.topics || [],
          })),
        },
        ctx,
      ),
    );
  }));

  return router;
};
