'use strict';

const express = require('express');
const { buildPowerWater, buildPlantDetail } = require('../domain/snapshot');
const { getPlant } = require('../config/powerplants');
const { parseCoolingModel, parseRange } = require('../lib/params');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

module.exports = function powerplantRoutes(ctx) {
  const router = express.Router();
  const { store, config, cache } = ctx;

  const currentInputs = async () => ({
    readings: await store.latestReadings(config.maxReadingAgeMs),
    generation: await store.latestGeneration(config.maxReadingAgeMs),
  });

  /** GET /powerplants?model=linear|thermal */
  router.get(
    '/powerplants',
    asyncRoute(async (req, res) => {
      const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);
      const payload = await cache.wrapAsync(`plants:${coolingModel}`, async () =>
        buildPowerWater({ ...(await currentInputs()), coolingModel }),
      );
      res.json(await withMeta(payload, ctx));
    }),
  );

  /** GET /powerplants/:id */
  router.get(
    '/powerplants/:id',
    asyncRoute(async (req, res) => {
      const plant = getPlant(req.params.id);
      if (!plant) return res.status(404).json({ error: `Unknown power plant '${req.params.id}'` });

      const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);
      const detail = buildPlantDetail(plant.id, { ...(await currentInputs()), coolingModel });
      return res.json(await withMeta(detail, ctx));
    }),
  );

  /**
   * GET /powerplants/:id/history?from=&to=
   *
   * Replays stored generation through the cooling model rather than storing water
   * figures directly. Keeping only the measured input means a corrected coefficient
   * fixes the whole history, instead of leaving a permanent record of the old model's
   * output with no way to tell which rows came from which version.
   */
  router.get(
    '/powerplants/:id/history',
    asyncRoute(async (req, res) => {
      const plant = getPlant(req.params.id);
      if (!plant) return res.status(404).json({ error: `Unknown power plant '${req.params.id}'` });

      const { fromMs, toMs, limit, error } = parseRange(req.query, { defaultDays: 7 });
      if (error) return res.status(400).json({ error });

      const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);
      const { computePlantWater } = require('../domain/cooling');
      const { allocateGeneration } = require('../domain/allocation');

      const rows = await store.generationSeries(fromMs, toMs, limit);
      const series = rows.map((row) => {
        const allocation = allocateGeneration(row.generationMw).find((a) => a.plantId === plant.id);
        const water = computePlantWater(plant, allocation ? allocation.powerMw : null, { model: coolingModel });
        return {
          timestamp: row.timestamp,
          powerMw: water.powerMw,
          withdrawalM3s: water.withdrawalM3s,
          consumptionM3s: water.consumptionM3s,
          confidence: allocation ? allocation.confidence : 'unavailable',
        };
      });

      return res.json(
        await withMeta(
          {
            plant: { id: plant.id, name: plant.name, capacityMw: plant.capacityMw },
            model: coolingModel,
            from: new Date(fromMs).toISOString(),
            to: new Date(toMs).toISOString(),
            count: series.length,
            series,
          },
          ctx,
        ),
      );
    }),
  );

  /** GET /water-use - power sector totals only, for the headline figure. */
  router.get(
    '/water-use',
    asyncRoute(async (req, res) => {
      const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);
      const power = await cache.wrapAsync(`plants:${coolingModel}`, async () =>
        buildPowerWater({ ...(await currentInputs()), coolingModel }),
      );

      res.json(
        await withMeta(
          {
            timestamp: power.timestamp,
            model: coolingModel,
            totals: power.totals,
            quality: power.quality,
            byPlant: power.plants
              .filter((p) => p.status === 'operating')
              .map((p) => ({
                id: p.id,
                name: p.name,
                powerMw: p.generation.powerMw,
                withdrawalM3s: p.water.withdrawalM3s,
                consumptionM3s: p.water.consumptionM3s,
                confidence: p.generation.confidence,
              }))
              .sort((a, b) => b.withdrawalM3s - a.withdrawalM3s),
          },
          ctx,
        ),
      );
    }),
  );

  return router;
};
