'use strict';

const express = require('express');
const { listStations } = require('../config/stations');
const { listPlants } = require('../config/powerplants');
const { buildPowerWater } = require('../domain/snapshot');
const { parseCoolingModel } = require('../lib/params');
const { asyncRoute } = require('../lib/async-route');

module.exports = function geoRoutes(ctx) {
  const router = express.Router();
  const { store, config, cache } = ctx;

  /**
   * GET /geojson - map-ready FeatureCollection.
   *
   * Served pre-shaped because the alternative is every map client reimplementing the
   * same join between the registry, the latest readings and the cooling model - and
   * getting the withdrawal/consumption distinction wrong on the way.
   *
   * Each feature carries a `weight` in [0,1] intended for symbol size or line width.
   * It is scaled by the square root of flow: the Danube carries ~600x the Túr, and a
   * linear scale would render everything except the Danube as an invisible hairline.
   */
  router.get('/geojson', asyncRoute(async (req, res) => {
    const coolingModel = parseCoolingModel(req.query.model, config.defaultCoolingModel);

    const payload = await cache.wrapAsync(`geojson:${coolingModel}`, async () => {
      const readings = await store.latestReadings(config.maxReadingAgeMs);
      const generation = await store.latestGeneration(config.maxReadingAgeMs);
      const power = buildPowerWater({ readings, generation, coolingModel });
      const powerById = new Map(power.plants.map((p) => [p.id, p]));

      const stationFeatures = listStations()
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map((station) => {
          const reading = readings[station.id];
          const flow = reading && Number.isFinite(reading.flowM3s) ? reading.flowM3s : null;
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
            properties: {
              kind: 'gauge',
              id: station.id,
              name: station.name,
              river: station.river,
              role: station.role,
              countsTowardBalance: station.role === 'inflow' || station.role === 'outflow',
              flowM3s: flow,
              longTermMeanM3s: station.meanFlow,
              ratioToMean: flow != null && station.meanFlow > 0 ? round(flow / station.meanFlow, 2) : null,
              hasLiveReading: flow != null,
              weight: sqrtWeight(flow ?? station.meanFlow, 2400),
              upstreamCountry: station.country || null,
              note: station.note || null,
            },
          };
        });

      const plantFeatures = listPlants()
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((plant) => {
          const detail = powerById.get(plant.id);
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [plant.lon, plant.lat] },
            properties: {
              kind: 'powerplant',
              id: plant.id,
              name: plant.name,
              type: plant.type,
              status: plant.status,
              capacityMw: plant.capacityMw,
              powerMw: detail ? detail.generation.powerMw : null,
              confidence: detail ? detail.generation.confidence : 'unavailable',
              coolingType: plant.cooling.type,
              withdrawalM3s: detail ? detail.water.withdrawalM3s : null,
              dischargeM3s: detail ? detail.water.dischargeM3s : null,
              consumptionM3s: detail ? detail.water.consumptionM3s : null,
              receivingWater: plant.receivingWater,
              weight: sqrtWeight(detail ? detail.water.withdrawalM3s : 0, 105),
            },
          };
        });

      return {
        type: 'FeatureCollection',
        generatedAt: new Date().toISOString(),
        properties: {
          provider: config.provider,
          synthetic: config.provider === 'fixture',
          coolingModel,
        },
        features: [...stationFeatures, ...plantFeatures],
      };
    });

    res.json(payload);
  }));

  return router;
};

function sqrtWeight(value, reference) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round(Math.min(1, Math.sqrt(value) / Math.sqrt(reference)), 3);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
