'use strict';

const { livePlants, plantsBySourceType } = require('../config/powerplants');

/**
 * Turns MAVIR's per-source-type generation aggregates into per-plant output.
 *
 * Two very different confidence levels come out of this, and keeping them apart is the
 * whole point of the module:
 *
 *   'measured'  - the plant is the sole generator of its source type, so the aggregate
 *                 is its output. Only Paks I qualifies, and it happens to be the plant
 *                 that dominates water withdrawal.
 *
 *   'estimated' - the aggregate is shared. It is split across plants in proportion to
 *                 capacity, which is a defensible first guess and definitely not the
 *                 truth: real dispatch follows marginal cost and maintenance schedules,
 *                 so at low system load the cheap plants run flat out and the expensive
 *                 ones sit idle, rather than everyone running at the same part load.
 *
 * The consequence is worth stating plainly: per-plant water figures for the gas fleet
 * are indicative. Their aggregate is sound; the split between them is not.
 */

/**
 * @param {object} generationMw  { nuclear: 1980, naturalGas: 1200, coal: 400, ... }
 * @returns {Array<object>} one entry per live plant
 */
function allocateGeneration(generationMw = {}) {
  const out = [];
  const handledTypes = new Set();

  for (const plant of livePlants()) {
    const { mode, mavirSourceType } = plant.powerSource;
    const aggregate = generationMw[mavirSourceType];

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
