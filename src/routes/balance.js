'use strict';

const express = require('express');
const { computeBalance } = require('../domain/balance');
const { buildSnapshot } = require('../domain/snapshot');
const { parseRange, parseMethod, parseCoolingModel } = require('../lib/params');

module.exports = function balanceRoutes(ctx) {
  const router = express.Router();
  const { store, config, cache } = ctx;

  /**
   * GET /balance - the national water balance right now.
   *
   * ?method=instant|lagged   compare same-timestamp readings, or shift each inflow back
   *                          by its travel time to the border exit (physically correct
   *                          during a flood wave, and it needs enough history to exist)
   * ?ungauged=true|false     include the estimated ungauged inflow term
   */
  router.get('/balance', (req, res) => {
    const method = parseMethod(req.query.method, config.defaultBalanceMethod);
    const includeUngauged = req.query.ungauged !== 'false';
    const key = `balance:${method}:${includeUngauged}`;

    const payload = cache.wrap(key, () => {
      const readings = store.latestReadings(config.maxReadingAgeMs);
      return computeBalance(readings, {
        method,
        includeUngauged,
        historyLookup: (stationId, atMs) => store.readingAt(stationId, atMs),
      });
    });

    res.json(withMeta(payload, ctx));
  });

  /**
   * GET /balance/history?from=&to=&limit=
   * Compact series for charting - timestamps plus the three headline flows.
   */
  router.get('/balance/history', (req, res) => {
    const { fromMs, toMs, limit, error } = parseRange(req.query, { defaultDays: 7 });
    if (error) return res.status(400).json({ error });

    const series = store.balanceSeries(fromMs, toMs, limit);
    return res.json(
      withMeta(
        {
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          count: series.length,
          series,
        },
        ctx,
      ),
    );
  });

  /**
   * GET /snapshot - water balance and power sector water use in one response.
   * This is the endpoint the map frontend polls.
   */
  router.get('/snapshot', (req, res) => {
    const method = parseMethod(req.query.method, config.defaultBalanceMethod);
    const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);
    const key = `snapshot:${method}:${coolingModel}`;

    const payload = cache.wrap(key, () => {
      const readings = store.latestReadings(config.maxReadingAgeMs);
      const generation = store.latestGeneration(config.maxReadingAgeMs);
      return buildSnapshot({ readings, generation, store, config, options: { method, coolingModel } });
    });

    res.json(withMeta(payload, ctx));
  });

  return router;
};

/**
 * Every response carries how it was produced.
 *
 * `synthetic: true` is the important one - it makes it impossible to consume fixture
 * data believing it came from a river, whether from the frontend or from curl.
 */
function withMeta(payload, ctx) {
  const lastPoll = ctx.store.lastPoll();
  return {
    ...payload,
    _meta: {
      provider: ctx.config.provider,
      synthetic: ctx.config.provider === 'fixture',
      lastPollAt: lastPoll ? lastPoll.timestamp : null,
      lastPollOk: lastPoll ? lastPoll.ok : null,
      apiVersion: 'v1',
    },
  };
}

module.exports.withMeta = withMeta;
