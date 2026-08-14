'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Where industry puts its water back.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER HALF OF THE DISCHARGE MAP
 * ---------------------------------------------------------------------------
 * The sewage register next door covers what leaves a town: 732 municipal works, their
 * capacity, their volume. It is most of the effluent by cubic metre and almost none of
 * the variety. Beside it, this is 424 points where water that was used by a dairy, a
 * tannery, a spa, a fish farm or a power station re-enters the water network - the half
 * of the picture that is not the town.
 *
 * They are two different registers, and this file will not add them together. The sewage
 * layer knows volumes; this one does not know a single one. A "total discharge" built
 * from both would be the municipal total with 424 unweighted dots stirred in, and would
 * read as though the industrial share were known. It is not published.
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THIS CANNOT SAY, LISTED BECAUSE THEY ARE WHAT GETS ASKED
 * ---------------------------------------------------------------------------
 *   - How much. No volume on any row.
 *   - How dirty. No load, no concentration, no permit limit.
 *   - Who. No operator, no company, no site name - the register names the receiving
 *     water and the sector, and that is the end of the row.
 *   - Now. The survey is the first river basin plan's, around 2009. A plant built since
 *     is not in it, which is most of what has been built.
 *
 * The `hasVolume` / `hasLoad` / `hasOperator` flags are carried out of the baked document
 * into the response for exactly this reason: a consumer should be able to see that these
 * are absent by design of the source rather than lost somewhere in this code.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAN SAY, AND IT IS NOT NOTHING
 * ---------------------------------------------------------------------------
 * Where, into which named water body, and from which sector - for every one of them. Two
 * facts fall straight out of that and neither is guessable in advance: thermal and bath
 * water is the second-largest source of industrial discharge in the country, and 88 of
 * the 125 food-industry outfalls do not go into a river at all, they go into the ground.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'industry.json');

let cached;

function loadIndustry({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The register, summarised, with the outfalls themselves.
 *
 * @param {number} limit  how many outfalls to include; 0 for all
 * @param {string} sector filter to one sector, exactly as the register spells it
 */
function buildIndustry({ limit = 0, sector = null, document } = {}) {
  const doc = document !== undefined ? document : loadIndustry();
  if (!doc || !Array.isArray(doc.points)) {
    return { available: false, reason: 'az ipari bevezetések nyilvántartása nincs betöltve' };
  }

  let points = doc.points;
  if (sector) {
    const wanted = String(sector).trim().toLowerCase();
    points = points.filter((p) => String(p.sector || '').toLowerCase() === wanted);
  }
  const matched = points.length;
  if (limit > 0) points = points.slice(0, limit);

  return {
    available: true,
    source: doc.source,
    sourceName: doc.sourceName,
    // First field after the source, not buried at the bottom: everything below it is
    // fifteen years old and a consumer that renders the numbers without the date is
    // making a claim about today that this register cannot support.
    vintage: doc.vintage,
    generated: doc.generated,
    count: doc.count,
    hasVolume: doc.hasVolume,
    hasLoad: doc.hasLoad,
    hasOperator: doc.hasOperator,
    sectors: doc.sectors,
    surfaceCount: doc.surfaceCount,
    groundwaterCount: doc.groundwaterCount,
    groundwaterSectors: doc.groundwaterSectors,
    waterCount: doc.waterCount,
    topWatersByOutfallCount: doc.topWatersByOutfallCount,
    ...(sector ? { sector, matched } : {}),
    points,
  };
}

/**
 * Outfalls grouped by the water body receiving them, most first.
 *
 * Surface only. A groundwater body is not a place a reader can look at on a river, and
 * mixing the two would produce a table where `sp.2.4.1` outranks the Danube.
 */
function byReceivingWater(document) {
  const doc = document !== undefined ? document : loadIndustry();
  if (!doc || !Array.isArray(doc.points)) return [];

  const groups = new Map();
  for (const p of doc.points) {
    if (p.target !== 'felszíni' || !p.waterName) continue;
    const group = groups.get(p.waterName) || { water: p.waterName, count: 0, sectors: {} };
    group.count += 1;
    if (p.sector) group.sectors[p.sector] = (group.sectors[p.sector] || 0) + 1;
    groups.set(p.waterName, group);
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      // The sector that put the most outfalls on this water. Named rather than counted
      // alone, because "six outfalls" and "six spa outfalls" are different sentences and
      // the second one is the one worth reading.
      dominantSector: Object.entries(g.sectors).sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => b.count - a.count || a.water.localeCompare(b.water, 'hu'));
}

/**
 * Which sectors discharge on a named water body.
 *
 * Matched on the exact water body name the register uses, which is a water BODY name and
 * not a river name: "Duna Szob-Baja között", not "Duna". Deliberately not loosened to a
 * prefix match - the Danube is six separate bodies in this register, they have different
 * outfalls on them, and collapsing them would report a discharge at Mohács as though it
 * were at Szob.
 */
function outfallsOn(waterName, document) {
  if (!waterName) return [];
  const doc = document !== undefined ? document : loadIndustry();
  if (!doc || !Array.isArray(doc.points)) return [];
  const wanted = String(waterName).trim().toLowerCase();
  return doc.points.filter((p) => String(p.waterName || '').toLowerCase() === wanted);
}

module.exports = { buildIndustry, loadIndustry, byReceivingWater, outfallsOn, DOCUMENT_PATH };
