'use strict';

/**
 * Turns a power plant's electrical output (MW) into water flows (m3/s).
 *
 * Two models are available and they answer slightly different questions:
 *
 *   'linear'  (default) - scales the plant's known nominal cooling flow by load.
 *                         This is the model in the project brief:
 *                             Q = P_now / P_nominal * Q_nominal
 *                         It is anchored on a published, real flow figure, so at high
 *                         load it is the more trustworthy of the two.
 *
 *   'thermal'           - derives the flow from the heat that physically has to be
 *                         rejected. Independent of any quoted flow figure, so it is
 *                         useful as a cross-check and for plants where no flow figure
 *                         is published.
 *
 * Both are approximations of a plant that in reality runs discrete pumps. A four-unit
 * station at 50% load is usually two units at full cooling flow, not four units at half
 * flow, so the true curve is a staircase and these models are its smooth envelope.
 */

const WATER_DENSITY = 1000; // kg/m3
const SPECIFIC_HEAT = 4182; // J/(kg*K)
const LATENT_HEAT_VAPORISATION = 2.43e6; // J/kg at ~30 C cooling tower conditions

// Of the heat a wet cooling tower rejects, this share leaves as evaporated water and
// the rest as warmed air. Drives how much water a tower actually eats.
const TOWER_EVAPORATIVE_SHARE = 0.85;

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_YEAR = 31_557_600;

/**
 * Heat that has to be dumped into the cooling circuit, in MW.
 *
 * Fuel heat in = P_el / efficiency. Of the waste heat, whatever goes up the stack never
 * reaches the condenser - that is what `stackLossFraction` removes. For a nuclear plant
 * there is no stack, so all of it lands in the condenser.
 */
function condenserDutyMw(powerMw, cooling) {
  const efficiency = cooling.netElectricalEfficiency;
  if (!efficiency || powerMw <= 0) return 0;
  const wasteHeat = powerMw * (1 / efficiency - 1);
  const stackLoss = cooling.stackLossFraction || 0;
  return wasteHeat * (1 - stackLoss);
}

/** Once-through: flow needed to carry the condenser duty away at a given temperature rise. */
function onceThroughFlowM3s(dutyMw, deltaTK) {
  if (dutyMw <= 0 || !deltaTK) return 0;
  return (dutyMw * 1e6) / (WATER_DENSITY * SPECIFIC_HEAT * deltaTK);
}

/** Wet tower: the water that must evaporate to carry the condenser duty away. */
function towerEvaporationM3s(dutyMw) {
  if (dutyMw <= 0) return 0;
  return (dutyMw * 1e6 * TOWER_EVAPORATIVE_SHARE) / (WATER_DENSITY * LATENT_HEAT_VAPORISATION);
}

/**
 * Closed-loop (pumped storage) make-up water.
 *
 * Deliberately ignores `powerMw`. A pumped storage scheme moves the same water up and
 * down; generating does not consume it. The only real demand is replacing what
 * evaporates off the reservoir surfaces, which is a function of weather and surface
 * area. Scaling this with MW - the intuitive thing to do - would be plain wrong.
 */
function closedLoopMakeupM3s(cooling) {
  const area = cooling.reservoirSurfaceM2 || 0;
  const mmPerYear = cooling.netEvaporationMmPerYear || 0;
  const volumePerYear = area * (mmPerYear / 1000);
  return volumePerYear / SECONDS_PER_YEAR;
}

/**
 * Compute water flows for one plant at one instant.
 *
 * @param {object} plant   entry from config/powerplants
 * @param {number|null} powerMw  current electrical output, or null if unknown
 * @param {object} [opts]
 * @param {'linear'|'thermal'} [opts.model='linear']
 * @returns {object} withdrawal / discharge / consumption in m3/s plus provenance
 */
function computePlantWater(plant, powerMw, opts = {}) {
  const model = opts.model === 'thermal' ? 'thermal' : 'linear';
  const cooling = plant.cooling;
  const capacity = plant.capacityMw;

  const result = {
    plantId: plant.id,
    model,
    coolingType: cooling.type,
    powerMw: powerMw == null ? null : round(powerMw, 1),
    loadFactor: powerMw == null || !capacity ? null : round(clamp(powerMw / capacity, 0, 1.15), 4),
    withdrawalM3s: 0,
    dischargeM3s: 0,
    consumptionM3s: 0,
    notes: [],
  };

  if (cooling.type === 'closed_loop') {
    const makeup = closedLoopMakeupM3s(cooling);
    result.withdrawalM3s = round(makeup, 4);
    result.consumptionM3s = round(makeup, 4);
    result.dischargeM3s = 0;
    result.notes.push('Closed-loop system: make-up water replaces reservoir evaporation and does not scale with generation.');
    return result;
  }

  // A plant with no live power figure still uses its idle circuits, but anything beyond
  // that would be invented. Report the floor and say so.
  if (powerMw == null) {
    const idle = cooling.idleWithdrawalM3s || 0;
    result.withdrawalM3s = round(idle, 3);
    result.dischargeM3s = round(idle * (1 - (cooling.consumptiveFraction || 0)), 3);
    result.consumptionM3s = round(idle * (cooling.consumptiveFraction || 0), 4);
    result.notes.push('No generation figure available; reporting idle auxiliary flow only.');
    return result;
  }

  let withdrawal;

  if (model === 'thermal') {
    const duty = condenserDutyMw(powerMw, cooling);
    result.condenserDutyMw = round(duty, 1);

    if (cooling.type === 'cooling_tower' || cooling.type === 'hybrid') {
      const evaporation = towerEvaporationM3s(duty);
      const consumptive = cooling.consumptiveFraction || 0.8;
      // Everything drawn in either evaporates or leaves as blowdown; the consumptive
      // fraction is what ties the two together.
      withdrawal = consumptive > 0 ? evaporation / consumptive : evaporation;
    } else {
      withdrawal = onceThroughFlowM3s(duty, cooling.condenserDeltaTK);
    }
  } else {
    // Load-proportional scaling of the published nominal flow.
    const ratio = capacity > 0 ? powerMw / capacity : 0;
    withdrawal = (cooling.nominalWithdrawalM3s || 0) * ratio;
  }

  // Auxiliary and service cooling keeps running below the modelled curve, so the
  // physical flow never drops under the idle floor even at very low load.
  const idle = cooling.idleWithdrawalM3s || 0;
  if (withdrawal < idle) {
    withdrawal = idle;
    result.notes.push('Clamped to idle auxiliary flow.');
  }

  const consumptiveFraction = cooling.consumptiveFraction || 0;
  const consumption = withdrawal * consumptiveFraction;

  result.withdrawalM3s = round(withdrawal, 3);
  result.consumptionM3s = round(consumption, 4);
  result.dischargeM3s = round(withdrawal - consumption, 3);

  if (cooling.type === 'once_through') {
    result.notes.push(
      `Once-through cooling: ${round((1 - consumptiveFraction) * 100, 1)}% of the withdrawal returns to the river, warmed.`,
    );
    if (cooling.condenserDeltaTK) {
      result.dischargeTemperatureRiseK = cooling.condenserDeltaTK;
    }
  } else if (cooling.type === 'cooling_tower' || cooling.type === 'hybrid') {
    result.notes.push(
      `Evaporative cooling: about ${round(consumptiveFraction * 100, 0)}% of the withdrawal is consumed, not returned.`,
    );
  }

  return result;
}

/**
 * Thermal load a once-through discharge places on its receiving river.
 *
 * The number people should actually care about: not "how many m3/s does it take" but
 * "how much does it warm the river". A 105 m3/s discharge at +9.7 K into a 2300 m3/s
 * Danube raises the whole river by roughly 0.4 K; the same discharge into a low-flow
 * summer Tisza would be a different story entirely.
 */
function computeThermalLoad(plantWater, riverFlowM3s, cooling) {
  if (!riverFlowM3s || riverFlowM3s <= 0) return null;
  if (plantWater.coolingType !== 'once_through') return null;
  const deltaT = cooling.condenserDeltaTK;
  if (!deltaT) return null;

  const mixedRiseK = (plantWater.withdrawalM3s * deltaT) / riverFlowM3s;
  return {
    riverFlowM3s: round(riverFlowM3s, 1),
    abstractionShareOfRiver: round(plantWater.withdrawalM3s / riverFlowM3s, 4),
    condenserRiseK: deltaT,
    mixedRiverRiseK: round(mixedRiseK, 3),
  };
}

/** Convert a flow to the volume it moves per day and per year. */
function flowToVolumes(m3s) {
  return {
    dailyM3: Math.round(m3s * SECONDS_PER_DAY),
    annualM3: Math.round(m3s * SECONDS_PER_YEAR),
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = {
  computePlantWater,
  computeThermalLoad,
  flowToVolumes,
  condenserDutyMw,
  onceThroughFlowM3s,
  towerEvaporationM3s,
  closedLoopMakeupM3s,
  constants: {
    WATER_DENSITY,
    SPECIFIC_HEAT,
    LATENT_HEAT_VAPORISATION,
    TOWER_EVAPORATIVE_SHARE,
    SECONDS_PER_DAY,
    SECONDS_PER_YEAR,
  },
};
