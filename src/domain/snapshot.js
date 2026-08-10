'use strict';

const { computeBalance } = require('./balance');
const { computePlantWater, computeThermalLoad, flowToVolumes } = require('./cooling');
const { allocateGeneration, allocationQuality } = require('./allocation');
const { listPlants, getPlant } = require('../config/powerplants');
const { getStation } = require('../config/stations');

/**
 * Assembles the single combined view the frontend asks for: the national water balance
 * and the power sector's water use, in one response, with provenance attached to every
 * number.
 */

function buildSnapshot({ readings, generation, historyLookup, availability, config, options = {} }) {
  const method = options.method || config.defaultBalanceMethod;
  const coolingModel = options.coolingModel || config.defaultCoolingModel;

  const balance = computeBalance(readings, {
    method,
    historyLookup: historyLookup || undefined,
    includeUngauged: options.includeUngauged !== false,
  });

  const power = buildPowerWater({ readings, generation, coolingModel, availability });

  return {
    generatedAt: new Date().toISOString(),
    balance,
    power,
    context: buildContext(balance, power),
  };
}

function buildPowerWater({ readings, generation, coolingModel, availability }) {
  const generationMw = (generation && generation.generationMw) || {};
  const allocations = allocateGeneration(generationMw);
  const allocationById = new Map(allocations.map((a) => [a.plantId, a]));

  const plants = [];
  const waterByPlant = {};

  for (const plant of listPlants()) {
    const allocation = allocationById.get(plant.id) || {
      powerMw: null,
      confidence: plant.status === 'operating' ? 'unavailable' : 'not_applicable',
      method: plant.status === 'operating' ? 'no live figure' : `plant status: ${plant.status}`,
    };

    // Availability, when present, replaces the inference the units model would make.
    const known = (availability && availability[plant.id]) || null;
    const unitsOnline = known ? known.unitsOnline : undefined;
    const water = computePlantWater(plant, allocation.powerMw, { model: coolingModel, unitsOnline });
    waterByPlant[plant.id] = water;

    // Thermal load needs the flow of the river actually receiving the discharge.
    let thermalLoad = null;
    if (plant.receivingWaterStationId) {
      const riverReading = readings[plant.receivingWaterStationId];
      const station = getStation(plant.receivingWaterStationId);
      const riverFlow = riverReading && Number.isFinite(riverReading.flowM3s)
        ? riverReading.flowM3s
        : station && station.meanFlow;
      thermalLoad = computeThermalLoad(water, riverFlow, plant.cooling);
    }

    plants.push({
      id: plant.id,
      name: plant.name,
      nameEn: plant.nameEn,
      type: plant.type,
      status: plant.status,
      location: { lat: plant.lat, lon: plant.lon },
      capacityMw: plant.capacityMw,
      receivingWater: plant.receivingWater,
      generation: {
        powerMw: water.powerMw,
        loadFactor: water.loadFactor,
        confidence: allocation.confidence,
        method: allocation.method,
        caveat: allocation.caveat || null,
      },
      // Reported whichever cooling model is selected. How many blocks are turning is a
      // fact about the plant, not an artefact of the water model chosen to describe it -
      // and it was previously visible only under `model=units`, so the site's default
      // view never showed it even when the figure was measured.
      units: water.unitCount || (known && plant.unitCount)
        ? {
          online: Number.isFinite(water.unitsOnline) ? water.unitsOnline : known.unitsOnline,
          total: water.unitCount || plant.unitCount,
          known: water.unitsKnown || Boolean(known),
          // Three different claims wearing the same number, and the difference is the
          // whole confidence story: `generation` means each unit's own output was read,
          // `outage-notices` means nobody filed anything against it, and neither means
          // it was inferred from a plant total and is a lower bound.
          basis: known ? known.basis : 'inferred',
          // Kept when the two sources disagree. A stopped unit with no outage notice is
          // either an unfiled outage or a machine on house load, and flattening that
          // into one number would hide the one thing worth noticing.
          declaredOnline:
            known && known.declaredOnline !== null && known.declaredOnline !== known.unitsOnline
              ? known.declaredOnline
              : null,
        }
        : null,
      water: {
        coolingType: water.coolingType,
        model: water.model,
        withdrawalM3s: water.withdrawalM3s,
        dischargeM3s: water.dischargeM3s,
        consumptionM3s: water.consumptionM3s,
        ...flowToVolumes(water.withdrawalM3s),
        consumptionDailyM3: Math.round(water.consumptionM3s * 86400),
        notes: water.notes,
      },
      thermalLoad,
      permit: plant.permit,
    });
  }

  const operating = plants.filter((p) => p.status === 'operating');
  const totals = {
    withdrawalM3s: round(sum(operating, (p) => p.water.withdrawalM3s), 2),
    dischargeM3s: round(sum(operating, (p) => p.water.dischargeM3s), 2),
    consumptionM3s: round(sum(operating, (p) => p.water.consumptionM3s), 3),
  };
  totals.dailyWithdrawalM3 = Math.round(totals.withdrawalM3s * 86400);
  totals.dailyConsumptionM3 = Math.round(totals.consumptionM3s * 86400);
  totals.returnedShare = totals.withdrawalM3s > 0 ? round(totals.dischargeM3s / totals.withdrawalM3s, 4) : null;

  return {
    timestamp: (generation && generation.timestamp) || null,
    generationMix: generationMw,
    totals,
    quality: allocationQuality(allocations, waterByPlant),
    plants,
  };
}

/**
 * The comparisons that make the raw numbers mean something.
 *
 * Withdrawal as a share of national inflow is the headline people expect. It reliably
 * looks alarming and reliably is not: it is a borrowed flow, returned a kilometre
 * downstream. Consumption as a share is the honest version of the same comparison, and
 * it is roughly two orders of magnitude smaller. Both are returned so the second one is
 * as easy to reach for as the first.
 */
function buildContext(balance, power) {
  const inflow = balance.inflow.totalM3s;
  if (!inflow || inflow <= 0) return null;

  return {
    powerWithdrawalShareOfInflow: round(power.totals.withdrawalM3s / inflow, 5),
    powerConsumptionShareOfInflow: round(power.totals.consumptionM3s / inflow, 6),
    note:
      'Withdrawal is water borrowed and returned; consumption is water actually lost. ' +
      'Comparing withdrawal against national inflow overstates the impact of once-through cooling by roughly two orders of magnitude.',
  };
}

function buildPlantDetail(plantId, { readings, generation, coolingModel, availability }) {
  const plant = getPlant(plantId);
  if (!plant) return null;
  const power = buildPowerWater({ readings, generation, coolingModel, availability });
  return power.plants.find((p) => p.id === plantId) || null;
}

function sum(arr, fn) {
  return arr.reduce((acc, item) => acc + (fn(item) || 0), 0);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { buildSnapshot, buildPowerWater, buildPlantDetail };
