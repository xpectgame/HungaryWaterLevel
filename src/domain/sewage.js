'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Where the country's water goes back into the country's water.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BELONGS ON A WATER-BALANCE SITE AT ALL
 * ---------------------------------------------------------------------------
 * The rest of this project measures water arriving and leaving across the border. Treated
 * sewage is neither: it is water that was already here, taken out of a river or an
 * aquifer, used, and put back a few kilometres downstream. On the national balance it is
 * close to invisible - eleven cubic metres a second against a Danube carrying two
 * thousand.
 *
 * It is on this site because the national figure is the wrong frame for it, and the
 * reader asking about it knows that. A works discharging half a cubic metre a second into
 * the Danube is nothing; the same works discharging into the canal behind a town is most
 * of what is in that canal by August. The interesting quantity is never the total, it is
 * the ratio to whatever is receiving it - which is why every figure here is per plant and
 * per receiving water, and why the national sum is reported once, plainly, and not led
 * with.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Everything here comes from the register: capacity in population equivalent, the organic
 * load actually arriving, and the volume of sewage in cubic metres a year. The only
 * arithmetic done to any of it is dividing that annual volume by the seconds in a year,
 * because a river is measured per second and the two cannot be compared otherwise.
 *
 * In particular, NOTHING converts population equivalent into a volume. That conversion
 * exists, everyone uses it, and it is a modelling assumption about litres per person per
 * day wearing a measurement's clothes. Where the register reports no volume - which is
 * 17 plants, but among them all three in Budapest, so 21% of the country's capacity -
 * this says so and leaves the number out.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'sewage.json');

let cached;

function loadSewage({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The national picture, plus the plants, largest first.
 *
 * @param {number} limit  how many plants to include; 0 for all
 */
function buildSewage({ limit = 0, document } = {}) {
  const doc = document !== undefined ? document : loadSewage();
  if (!doc || !Array.isArray(doc.plants)) {
    return { available: false, reason: 'a szennyvíz-nyilvántartás nincs betöltve' };
  }

  const plants = limit > 0 ? doc.plants.slice(0, limit) : doc.plants;

  return {
    available: true,
    source: doc.source,
    generated: doc.generated,
    count: doc.count,
    totalCapacityPe: doc.totalCapacityPe,
    totalM3Year: doc.totalM3Year,
    totalM3s: doc.totalM3s,
    // Carried so the consumer can qualify the total rather than quote it as complete.
    volumeReportedCount: doc.volumeReportedCount,
    volumeCapacityShare: doc.volumeCapacityShare,
    volumeMissingLargest: doc.volumeMissingLargest,
    receivingWaterCount: doc.receivingWaterCount,
    byReceivingWater: byReceivingWater(doc.plants),
    plants: plants.map((p) => ({ ...p, loadRatio: loadRatio(p), strain: strainOf(loadRatio(p)) })),
  };
}

/**
 * How hard the works is being pushed: the load arriving over the load it was built for.
 *
 * THE ONLY "HOW BAD IS IT" FIGURE THIS REGISTER SUPPORTS. The compliance columns exist
 * and are empty - one plant of 738 reports a non-compliant load - so anything claiming
 * to rank plants by how dirty their effluent is would be invented. What IS reported, for
 * 717 of them, is the design capacity and the organic load actually arriving, and 153
 * are over their design.
 *
 * WHAT IT DOES NOT MEAN. A works over its design load is not automatically discharging
 * out of spec: plants are built with margin and a permit is written on the effluent, not
 * on the inlet. What it does mean is that the margin is gone, and that a works past its
 * capacity has nothing left to absorb a wet day or a holiday weekend. That distinction is
 * carried in the wording everywhere this is shown, because "over capacity" and "polluting"
 * are different claims and only the first one is measured here.
 */
function loadRatio(plant) {
  if (!plant || !plant.loadPe || !plant.capacityPe || plant.capacityPe <= 0) return null;
  return round(plant.loadPe / plant.capacityPe, 3);
}

/**
 * Four buckets, because a continuous ramp over a ratio that reaches 25 is a map where
 * everything except one village is the same colour.
 */
function strainOf(ratio) {
  if (ratio === null) return null;
  if (ratio < 0.75) return 'ok';
  if (ratio < 1) return 'near';
  if (ratio < 1.5) return 'over';
  return 'far-over';
}

/**
 * Grouped by the watercourse each one discharges into, biggest load first.
 *
 * Only the 133 plants whose receiving water the register actually names. The other 599
 * are not distributed among them by proximity or by guesswork: a plant assigned to the
 * wrong stream would make that stream's total wrong in the one direction nobody would
 * think to check.
 */
function byReceivingWater(plants) {
  const groups = new Map();
  for (const p of plants) {
    if (!p.receivingWater) continue;
    const g = groups.get(p.receivingWater) || { water: p.receivingWater, plants: 0, capacityPe: 0, m3s: 0 };
    g.plants += 1;
    g.capacityPe += p.capacityPe || 0;
    g.m3s += p.m3s || 0;
    groups.set(p.receivingWater, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, m3s: round(g.m3s, 4) }))
    .sort((a, b) => b.capacityPe - a.capacityPe);
}

/**
 * What one plant's discharge is next to a river actually carrying that much.
 *
 * The number this whole section exists for. "Half a cubic metre a second" means nothing
 * on its own; "a fifth of what the stream is carrying today" is the same fact in a form
 * a reader can act on, and it is the ratio of two measurements with nothing modelled
 * between them.
 *
 * Returns null rather than a number when the river's flow is unknown or zero. A zero
 * denominator here would produce Infinity and read as "the entire river is sewage",
 * which is the single most defamatory thing this page could print about a watercourse.
 */
function shareOfFlow(plantM3s, riverM3s) {
  if (!Number.isFinite(plantM3s) || !Number.isFinite(riverM3s) || riverM3s <= 0) return null;
  return round(plantM3s / riverM3s, 4);
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { buildSewage, loadSewage, byReceivingWater, shareOfFlow, loadRatio, strainOf, DOCUMENT_PATH };
