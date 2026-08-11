'use strict';

/**
 * The groundwater observation wells this project reads.
 *
 * ---------------------------------------------------------------------------
 * WHAT TOOK SO LONG TO FIND
 * ---------------------------------------------------------------------------
 * The first scan of this network concluded "groundwater is not published here" and was
 * wrong. It asked AdatFajtaKod 69 (talajvízállás) and 70 (rétegvízszint) under
 * AdatTipusKod 100 - `operatív` - got almost nothing back, and filed a negative result.
 *
 * The mistake was in the question. 100 means operational telemetry, and a well read by
 * an observer on a fortnightly round is not telemetry. Varying the data type instead of
 * the kind found it immediately:
 *
 *     AdatFajtaKod 70 x AdatTipusKod 2   ->  160 wells answered
 *     AdatFajtaKod 70 x AdatTipusKod 100 ->  134 answered, 10 recent
 *     AdatFajtaKod 69 x anything         ->  nothing, anywhere, ever
 *
 * So 69 stays a genuine negative: the shallow water table - the one a garden well reaches
 * and a maize root system drinks - is not served by this API under any pair tried. What
 * IS served is 70, rétegvíz: the confined aquifer below it. They are different water and
 * this file must never let one be labelled the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO NATIONAL GROUNDWATER NUMBER ON THIS SITE
 * ---------------------------------------------------------------------------
 * The series is a depth against each well's own datum, and the datum is per-well. Read
 * across the network the current values run from -8156.95 to +8039, which is not a range
 * of water levels - it is at least three different conventions in one column:
 *
 *   - most wells report a NEGATIVE depth in METRES below the datum;
 *   - at least one (Budajenő-2) reports a negative depth in CENTIMETRES;
 *   - the Miskolc directorate's wells report a POSITIVE depth in centimetres, so for
 *     them a bigger number means DEEPER water, the opposite of everywhere else.
 *
 * That is not a guess. Each well's catalogue row carries `Npt`, its datum in metres above
 * the Baltic, so datum plus depth is an elevation that can be checked against known
 * hydrogeology - and it checks out only under the mixed reading:
 *
 *     Piliscsaba-2       248.58 - 161.44 m  = 123.9 mBf
 *     Budapest Adyliget  414.75 - 289.07 m  = 125.7 mBf
 *     Zsámbék-70         276.01 - 148.92 m  = 127.1 mBf
 *     Budajenő-2         216.87 -  81.57 m  = 135.3 mBf   (read as centimetres)
 *
 * Four wells scattered across the Buda hills landing within twelve metres of each other
 * on the regional karst water table, which is where the literature puts it. Read
 * uniformly, in either unit, they do not.
 *
 * The consequence is a rule this project holds to: NOTHING IS AVERAGED ACROSS WELLS AND
 * NO DEPTH IS PUBLISHED AS A DEPTH. A mean of these numbers would be a fabrication with
 * a decimal point on it. What is published is each well against its own ten-year record
 * for the same calendar month - a percentile, which is unit-free and sign-free - and the
 * count of wells sitting low. "79 of 89 comparable wells are below their own ten-year
 * August quartile, and 52 of them are lower than any August day in that record" is a real
 * national statement built entirely out of within-well comparisons, and it is the
 * strongest one this data can support.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE WELLS ARE, WHICH IS NOT EVERYWHERE
 * ---------------------------------------------------------------------------
 * 524 wells are published; 160 answered inside 60 days; 106 had reported within 30 when
 * this registry was built (2026-08-11). Those 106 are spread over nine of the twelve
 * directorates, and very unevenly: Budapest (38) and Debrecen (24) are more than half of
 * them; Szeged has one; Baja, Gyula and Nyíregyháza have none at all. `wellCoverage()`
 * puts that in the payload rather than leaving a reader to infer it from a thin-looking
 * map - an empty county here means unmeasured, not fine.
 *
 * The thirty-day bar is deliberate and load-bearing. At seven days the same scan finds
 * 48 wells, two thirds of them around Budapest - a national groundwater map of the Buda
 * hills. Groundwater moves centimetres a month; three weeks is not stale.
 */

const WELLS = require('./wells.json');

/**
 * The one (kind, type) pair that returns groundwater, and what it is called.
 *
 * `label` is what the upstream calls it, and it is the confined aquifer rather than the
 * shallow table. Every string this project shows a reader has to keep that distinction:
 * a reader who takes "rétegvíz" for "talajvíz" will conclude their own garden well is
 * fine when nothing here measured it.
 */
const WELL_KIND = Object.freeze({
  adatFajtaKod: 70,
  adatTipusKod: 2,
  label: 'rétegvízszint',
  labelHu: 'rétegvíz',
  note: 'Confined-aquifer level. NOT talajvíz (the shallow water table), which this API does not serve.',
});

/** Directorate names, for saying where the network is and is not. */
const VIZIG = Object.freeze({
  1: 'Észak-dunántúli (Győr)',
  2: 'Közép-Duna-völgyi (Budapest)',
  3: 'Alsó-Duna-völgyi (Baja)',
  4: 'Közép-dunántúli (Székesfehérvár)',
  5: 'Dél-dunántúli (Pécs)',
  6: 'Nyugat-dunántúli (Szombathely)',
  7: 'Közép-Tisza-vidéki (Szolnok)',
  8: 'Észak-magyarországi (Miskolc)',
  9: 'Tiszántúli (Debrecen)',
  10: 'Körös-vidéki (Gyula)',
  11: 'Alsó-Tisza-vidéki (Szeged)',
  12: 'Felső-Tisza-vidéki (Nyíregyháza)',
});

function listWells() {
  return WELLS;
}

function getWell(id) {
  return WELLS.find((w) => w.id === id) || null;
}

/**
 * What this network does and does not see, as a payload field.
 *
 * The same reasoning as the rainfall registry's coverage block: a map with holes in it
 * looks like a country with no wells there unless the response says otherwise.
 */
function wellCoverage() {
  const byVizig = new Map();
  for (const well of WELLS) byVizig.set(well.vizig, (byVizig.get(well.vizig) || 0) + 1);
  const present = [...byVizig.entries()].sort((a, b) => b[1] - a[1]);
  const missing = Object.keys(VIZIG).map(Number).filter((v) => !byVizig.has(v));
  return {
    wells: WELLS.length,
    directorates: present.map(([id, count]) => ({ id, name: VIZIG[id] || String(id), wells: count })),
    missingDirectorates: missing.map((id) => ({ id, name: VIZIG[id] || String(id) })),
    kind: WELL_KIND.label,
    note:
      'Confined-aquifer (rétegvíz) observation wells that reported within 30 days when the ' +
      'registry was built. Not a uniform national grid: coverage is dense around Budapest ' +
      'and Debrecen and absent in three directorates. Levels are depths against each ' +
      "well's own datum in mixed units, so they are never averaged or compared between " +
      'wells - only against that same well\'s own record.',
  };
}

module.exports = { listWells, getWell, wellCoverage, WELL_KIND, VIZIG, WELLS };
