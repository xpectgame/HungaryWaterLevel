'use strict';

const express = require('express');
const { buildDay, dayToCsv, baselineStamp, balanceForDay, SCHEMA } = require('../jobs/archive');
const { asyncRoute } = require('../lib/async-route');

/**
 * The record, addressable by date.
 *
 * A dashboard answers "what is happening". This answers "what happened on 11 August
 * 2026", and it has to keep answering it in 2036. That means: a URL per day, plain
 * formats, and no dependency on this code still existing - a CSV opened in ten years by
 * someone who has never seen this repository has to be self-explanatory.
 *
 * Cached hard: a past day cannot change, so it is immutable and says so.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function archiveRoutes(ctx) {
  const router = express.Router();
  const { store } = ctx;

  /** GET /archive - what this is and how to fetch it. */
  router.get('/archive', asyncRoute(async (req, res) => {
    const stats = await store.stats();
    res.json({
      what: 'One immutable record per day of every gauge and lake this project measures.',
      why:
        'The live site is a dashboard; this is the evidence. Preserved so that a reader ' +
        'in ten years can check what the rivers were doing today, rather than depending ' +
        'on the upstream still serving it.',
      schema: SCHEMA,
      formats: {
        json: '/archive/2026-08-11.json',
        csv: '/archive/2026-08-11.csv',
      },
      baseline: baselineStamp(),
      held: stats,
      licence: 'Forrás: Országos Vízügyi Főigazgatóság vízrajzi nyílt adatok. Szabadon használható a forrás megjelölésével.',
    });
  }));

  /** GET /archive/:date.csv|.json - one day, written once. */
  router.get('/archive/:file', asyncRoute(async (req, res) => {
    const match = /^(\d{4}-\d{2}-\d{2})\.(csv|json)$/.exec(req.params.file);
    if (!match) {
      return res.status(400).json({ error: 'Use /archive/YYYY-MM-DD.csv or .json' });
    }
    const [, date, format] = match;
    if (!DAY_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return res.status(400).json({ error: `Unparseable date '${date}'` });
    }

    const isPast = Date.parse(`${date}T00:00:00Z`) + 86400000 < Date.now();
    const day = await buildDay(store, `${date}T12:00:00Z`);

    if (!day.rows.length) {
      return res.status(404).json({
        error: `No measurements held for ${date}`,
        note: 'Either the day is in the future, or it predates this deployment.',
      });
    }

    // A finished day cannot change, so it is immutable. Today can still gain readings,
    // so it is not - saying otherwise would freeze a partial day in every cache between
    // here and the reader.
    res.set('Cache-Control', isPast ? 'public, max-age=31536000, immutable' : 'public, max-age=300');

    if (format === 'csv') {
      res.type('text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="hovafolyik-${date}.csv"`);
      return res.send(dayToCsv(day));
    }

    return res.json({
      ...day,
      complete: isPast,
      balance: await balanceForDay(store, `${date}T12:00:00Z`),
      // Stamped on every day, not just the index: a file downloaded on its own has to
      // carry what it was measured against, or the percentages in it become unreadable
      // the moment the baseline is rebaked.
      baseline: baselineStamp(),
      source: 'Országos Vízügyi Főigazgatóság vízrajzi nyílt adatok',
    });
  }));

  return router;
};
