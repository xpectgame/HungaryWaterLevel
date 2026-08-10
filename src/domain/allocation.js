'use strict';

const { livePlants, plantsBySourceType } = require('../config/powerplants');

/**
 * Turns MAVIR's per-source-type generation aggregates into per-plant output.
 *
 * Two very different confidence levels come out of this, and keeping them apart is the
 * whole point of the module:
 *
 *   'measured'  - either the plant is the sole generator of its source type, so the
 *                 aggregate is its output (Paks I, which also dominates withdrawal), or
 *                 ENTSO-E publishes the plant's own generation units and the figure is
 *                 their sum.
 *
 *   'estimated' - the aggregate is shared and the plant publishes no units. It is split
 *                 across plants in proportion to capacity, which is a defensible first
 *                 guess and definitely not the truth: real dispatch follows marginal
 *                 cost and maintenance schedules, so at low system load the cheap plants
 *                 run flat out and the expensive ones sit idle, rather than everyone
 *                 running at the same part load.
 *
 * The gas fleet used to be entirely in the second category, and that was the largest
 * caveat this project carried. A73 moved Gönyű, Dunamenti and Csepel into the first,
 * along with Mátra on the coal aggregate. Tisza II is the one that remains: it
 * publishes no units, and the leftover aggregate is not its output either, because the
 * same aggregate carries Budapest CHPs this registry does not model.
 */

/**
 * @param {object} generationMw  { nuclear: 1980, naturalGas: 1200, coal: 400, ... }
 * @returns {Array<object>} one entry per live plant
 */
function allocateGeneration(generationMw = {}, { measuredMw = null } = {}) {
  const out = [];
  const handledTypes = new Set();

  for (const plant of livePlants()) {
    const { mode, mavirSourceType } = plant.powerSource;
    const aggregate = generationMw[mavirSourceType];

    // ENTSO-E A73 publishes output per generation unit, so for a plant whose units are
    // known the split stops being a split at all - it is the sum of its own machines.
    // This is what retires the caveat below for four of the five sharing plants: their
    // figure is no longer a capacity-weighted guess at merit-order dispatch.
    //
    // Tisza II is the exception and stays estimated: it publishes no units, so there is
    // nothing to sum. Subtracting the measured plants from the aggregate would not give
    // it either, because the aggregate also carries Budapest CHPs this registry does not
    // model - the remainder is not one plant's worth of anything.
    // Only where it replaces an estimate. For an 'exclusive' plant the source-type
    // aggregate already IS that plant's output, and the two documents disagree about
    // Paks - A75 read 168 MW while the A73 units summed to 260 at the same minute,
    // probably gross against net, possibly something else. Swapping a working measured
    // figure for a second one that differs by half, on a hunch about which is which,
    // would be trading a known number for an unexplained one.
    const measured = mode !== 'exclusive' && measuredMw && measuredMw[plant.id];
    if (Number.isFinite(measured)) {
      out.push({
        plantId: plant.id,
        powerMw: clamp(measured, 0, plant.capacityMw * 1.05),
        confidence: 'measured',
        sourceType: mavirSourceType,
        method: 'sum of this plant\'s own generation units (ENTSO-E A73)',
      });
      // Deliberately NOT added to handledTypes: the others sharing this source type
      // still need their estimated split, and marking the type handled would leave
      // them with no figure at all.
      continue;
    }

    if (!Number.isFinite(aggregate)) {
      out.push({
        plantId: plant.id,
        powerMw: null,
        confidence: 'unavailable',
        sourceType: mavirSourceType,
        method: 'no aggregate published for this source type',
      });
      continue;
    }

    if (mode === 'exclusive') {
      // Sole generator of its type: the aggregate is the plant, minus nothing.
      out.push({
        plantId: plant.id,
        powerMw: clamp(aggregate, 0, plant.capacityMw * 1.05),
        confidence: 'measured',
        sourceType: mavirSourceType,
        method: `sole ${mavirSourceType} generator in Hungary - aggregate equals plant output`,
      });
      handledTypes.add(mavirSourceType);
      continue;
    }

    // Shared aggregate: split proportionally, but only once per source type.
    if (!handledTypes.has(mavirSourceType)) {
      const peers = plantsBySourceType(mavirSourceType);
      const totalCapacity = peers.reduce((sum, p) => sum + p.capacityMw, 0);

      for (const peer of peers) {
        const share = totalCapacity > 0 ? peer.capacityMw / totalCapacity : 0;
        out.push({
          plantId: peer.id,
          powerMw: clamp(aggregate * share, 0, peer.capacityMw),
          confidence: 'estimated',
          sourceType: mavirSourceType,
          method: `capacity-weighted share (${Math.round(share * 100)}%) of the ${mavirSourceType} aggregate`,
          caveat: 'Real dispatch is merit-order driven; treat the split between plants as indicative.',
        });
      }
      handledTypes.add(mavirSourceType);
    }
  }

  // Preserve registry order and drop any duplicate a source type may have produced.
  const seen = new Set();
  return out.filter((entry) => {
    if (seen.has(entry.plantId)) return false;
    seen.add(entry.plantId);
    return true;
  });
}

/**
 * How much of the modelled water use rests on a directly readable generation figure.
 * Reported alongside the aggregate so a consumer can judge it at a glance.
 */
function allocationQuality(allocations, waterByPlant) {
  let measuredWithdrawal = 0;
  let totalWithdrawal = 0;

  for (const alloc of allocations) {
    const water = waterByPlant[alloc.plantId];
    if (!water) continue;
    totalWithdrawal += water.withdrawalM3s;
    if (alloc.confidence === 'measured') measuredWithdrawal += water.withdrawalM3s;
  }

  return {
    measuredWithdrawalShare: totalWithdrawal > 0 ? round(measuredWithdrawal / totalWithdrawal, 3) : 0,
    plantsMeasured: allocations.filter((a) => a.confidence === 'measured').length,
    plantsEstimated: allocations.filter((a) => a.confidence === 'estimated').length,
    plantsUnavailable: allocations.filter((a) => a.confidence === 'unavailable').length,
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { allocateGeneration, allocationQuality };
