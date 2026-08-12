'use strict';

/**
 * The shallow water table - talajvíz - and the network that measures it.
 *
 * ---------------------------------------------------------------------------
 * THE NEGATIVE RESULT THIS FILE OVERTURNS
 * ---------------------------------------------------------------------------
 * Several files in this project stated, as a settled finding, that talajvíz is not
 * published: AdatFajtaKod 69 answered nowhere, under any data type, at any well. That was
 * wrong, and the way it was wrong is worth keeping. The CODE was right. The NETWORK was
 * wrong. 69 had only ever been asked of vmoType 13 - the confined-aquifer wells - which
 * do not measure the shallow table and correctly returned nothing.
 *
 * vmoType 12 exists, holds 2030 stations, had never been requested by anything here, and
 * answers code 69 immediately:
 *
 *     1150 stations answered inside 60 days
 *      771 had reported inside 30
 *      525 inside a week, at roughly six readings a day
 *
 * across all twelve directorates. For comparison the confined-aquifer registry has 106
 * stations over nine directorates, two thirds of them around Budapest.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE CAN BE READ AS A NUMBER AND THE OTHER CANNOT
 * ---------------------------------------------------------------------------
 * The rétegvíz network reports in at least three conventions at once - metres and
 * centimetres, some wells with the sign reversed - so nothing there may be averaged or
 * compared between wells. This network does not have that problem: of 1150 current
 * readings exactly ONE was negative, and the values run 220 to 2102 with a median of 486.
 * One convention, one unit.
 *
 * ---------------------------------------------------------------------------
 * WHICH DIRECTION IS DRY, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 * This is a DEPTH: bigger means the water table is further down, which means drier. That
 * is the opposite of every other quantity on this site, where a bigger number is more
 * water, and getting it backwards would not fail loudly - it would print "unusually wet"
 * through a drought.
 *
 * So it was not assumed. The bake measured it, from the one thing about groundwater that
 * is not in doubt: the table stands highest after the spring melt and lowest at the end
 * of summer. Across 684 stations with ten years each:
 *
 *     spring (Mar-Apr) median      379.15
 *     late summer (Aug-Sep) median 422.72
 *
 * Late summer is 44 cm deeper. The number is a depth, and DEPTH_MEANS_DRIER below says
 * so once, where every consumer can read it, instead of each of them re-deriving it.
 */

const WELLS = require('./shallow-wells.json');

/**
 * The pair that answers, and what it measures.
 *
 * AdatTipusKod 100 here, not 2 as the confined wells use: this network IS operational
 * telemetry, reporting several times a day, which is why 100 works for it and did not
 * for the fortnightly dip-meter rounds.
 */
const SHALLOW_KIND = Object.freeze({
  adatFajtaKod: 69,
  adatTipusKod: 100,
  vmoType: 12,
  label: 'talajvízállás',
  labelHu: 'talajvíz',
  note: 'Shallow water-table depth below the station datum, in centimetres. Larger means deeper.',
});

/**
 * Larger reading = deeper water = drier.
 *
 * Exported as a named constant rather than left as a comment because it inverts the
 * meaning of every ranking built on this network, and a consumer that forgets it produces
 * a confidently wrong answer rather than an obviously broken one.
 */
const DEPTH_MEANS_DRIER = true;

const VIZIG = require('./wells').VIZIG;

function listShallowWells() {
  return WELLS;
}

function getShallowWell(id) {
  return WELLS.find((w) => w.id === id) || null;
}

/**
 * What this network sees, which - unusually for this project - is most of the country.
 */
function shallowCoverage() {
  const byVizig = new Map();
  for (const well of WELLS) byVizig.set(well.vizig, (byVizig.get(well.vizig) || 0) + 1);
  const present = [...byVizig.entries()].sort((a, b) => b[1] - a[1]);
  const missing = Object.keys(VIZIG).map(Number).filter((v) => !byVizig.has(v));
  return {
    stations: WELLS.length,
    directorates: present.map(([id, count]) => ({ id, name: VIZIG[id] || String(id), stations: count })),
    missingDirectorates: missing.map((id) => ({ id, name: VIZIG[id] || String(id) })),
    kind: SHALLOW_KIND.label,
    note:
      'Shallow water-table (talajvíz) observation stations that reported within 30 days ' +
      'when the registry was built, from OVF\'s national network. All twelve directorates ' +
      'are represented. The reading is a depth below the station datum in centimetres: ' +
      'larger means deeper, which means drier.',
  };
}

module.exports = {
  listShallowWells, getShallowWell, shallowCoverage,
  SHALLOW_KIND, DEPTH_MEANS_DRIER, WELLS,
};
