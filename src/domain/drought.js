'use strict';

const { listShallowWells, shallowCoverage, SHALLOW_KIND } = require('../config/shallow-wells');
const { rankShallow } = require('./flow-history');

/**
 * How dry the ground is, from measurements rather than from a rainfall ratio.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY THE OLD SENTENCE HAD TO GO
 * ---------------------------------------------------------------------------
 * The page used to carry this admission under its rainfall figure:
 *
 *     "Not an official drought index - a real one looks at soil moisture and the
 *      rainfall deficit as well."
 *
 * That was honest and it was also a description of a hole. Rainfall says how much water
 * ARRIVED and nothing about how much is still there: two Augusts with identical rainfall
 * are different droughts if one followed a wet spring. Everything a reader actually wants
 * to know lives in the difference.
 *
 * The hole is now filled with the other half, measured: the shallow water table, from
 * OVF's own national observation network, 770 stations across all twelve directorates,
 * read several times a day. That is not soil moisture in the laboratory sense - nobody
 * publishes a national soil-moisture series here - but it is the water a root system can
 * reach and a garden well draws from, and it integrates months of rainfall rather than
 * days of it, which is precisely the memory the rainfall figure lacks.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is NOT the Hungarian Drought Index. HDI is published by the Aszálymonitoring service
 * run by OVF and the chamber of agriculture, it is computed differently, and this project
 * cannot fetch it: that service renders its numbers server-side per station with no data
 * endpoint behind it. Calling this "the official drought index" would be borrowing an
 * authority it does not have, which is the exact failure the old sentence was avoiding.
 *
 * So the claim is stated precisely instead: official measurements, from the official
 * network, combined here. The measurements are theirs; the arithmetic is ours.
 *
 * ---------------------------------------------------------------------------
 * WHY A COUNT AND NOT AN INDEX NUMBER
 * ---------------------------------------------------------------------------
 * Same reasoning as the groundwater section. Every station is ranked against its own ten
 * years for the same calendar month, so no depth is ever compared with another station's
 * depth, and the national figure is a count of stations sitting low. A single index value
 * would require weighting stations against each other, which needs assumptions this data
 * does not supply.
 */

/** Percentile at or below which a station counts as dry. */
const DRY_PERCENTILE = 25;
/** And where "unusually" starts meaning something. */
const VERY_DRY_PERCENTILE = 5;

/**
 * @param {object|Map} readings  stationId -> { value, at } - depth in cm, larger = deeper
 * @param {object} [opts]
 * @param {Date|number} [opts.at]
 * @param {object} [opts.document]
 * @param {number} [opts.maxAgeDays=14]  telemetered network, so a fortnight is generous
 * @param {object} [opts.rainfall]       the rainfall document, to state both inputs
 */
function assessDrought(readings, opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date();
  const maxAgeDays = opts.maxAgeDays === undefined ? 14 : opts.maxAgeDays;
  const get = (id) => (readings instanceof Map ? readings.get(id) : readings && readings[id]);

  const stations = [];
  const statuses = {};
  const bump = (code) => { statuses[code] = (statuses[code] || 0) + 1; };

  for (const well of listShallowWells()) {
    const raw = get(well.id);
    const reading = raw && typeof raw === 'object' ? raw : { value: raw, at: null };
    const depthCm = Number.isFinite(reading.value) ? reading.value : null;
    const readAt = reading.at ? new Date(reading.at) : null;
    const ageDays = readAt ? (at - readAt) / 86400000 : null;
    const stale = ageDays !== null && ageDays > maxAgeDays;

    let rank = null;
    let status;
    if (depthCm === null) status = 'no-reading';
    else if (stale) status = 'stale';
    else {
      rank = rankShallow(well.id, depthCm, { at, document: opts.document });
      status = rank ? 'ok' : 'no-record';
    }
    bump(status);

    stations.push({
      id: well.id,
      name: well.name,
      settlement: well.settlement,
      vizig: well.vizig,
      lat: well.lat,
      lon: well.lon,
      depthCm,
      at: readAt ? readAt.toISOString() : null,
      ageDays: ageDays === null ? null : Math.round(ageDays),
      status,
      rank,
    });
  }

  const ranked = stations.filter((s) => s.rank);
  const atOrBelow = (limit) => ranked.filter((s) => s.rank.percentile !== null && s.rank.percentile <= limit).length;
  const dry = atOrBelow(DRY_PERCENTILE);

  // The county-level picture, because a national count hides where it is happening and
  // "where" is the first thing anyone asks. Per directorate rather than per county: the
  // directorate is the unit the network itself is organised in, so a share computed over
  // it is a share of something real rather than of an arbitrary grouping.
  const byVizig = new Map();
  for (const s of ranked) {
    const row = byVizig.get(s.vizig) || { vizig: s.vizig, ranked: 0, dry: 0, veryDry: 0, deepest: 0 };
    row.ranked += 1;
    if (s.rank.percentile <= DRY_PERCENTILE) row.dry += 1;
    if (s.rank.percentile <= VERY_DRY_PERCENTILE) row.veryDry += 1;
    if (s.rank.belowRecord) row.deepest += 1;
    byVizig.set(s.vizig, row);
  }

  return {
    kind: SHALLOW_KIND.label,
    month: at.getUTCMonth() + 1,
    stations,
    regions: [...byVizig.values()]
      .map((r) => ({ ...r, dryShare: r.ranked ? Math.round((r.dry / r.ranked) * 1000) / 1000 : null }))
      .sort((a, b) => (b.dryShare || 0) - (a.dryShare || 0)),
    summary: {
      registered: stations.length,
      comparable: ranked.length,
      dry,
      veryDry: atOrBelow(VERY_DRY_PERCENTILE),
      // "Deeper than any day of this month in the ten-year record" - the strongest
      // statement available, and unlike a percentile it needs no explanation.
      deepestOnRecord: ranked.filter((s) => s.rank.belowRecord).length,
      wet: ranked.filter((s) => s.rank.percentile !== null && s.rank.percentile >= 75).length,
      dryShare: ranked.length ? Math.round((dry / ranked.length) * 1000) / 1000 : null,
      statuses,
      dryPercentile: DRY_PERCENTILE,
      veryDryPercentile: VERY_DRY_PERCENTILE,
    },
    // Both halves of what makes a drought, side by side, each labelled with what it is.
    inputs: {
      shallowWaterTable: {
        source: 'OVF országos talajvíz-észlelőhálózat (vmoType 12, AdatFajtaKod 69)',
        stations: stations.length,
        comparedAgainst: 'az adott állomás saját tízéves, azonos naptári havi eloszlása',
      },
      rainfall: opts.rainfall
        ? {
          source: 'OVF meteorológiai hálózat (AdatFajtaKod 71)',
          windowDays: opts.rainfall.windowDays,
          ratioToNormal: opts.rainfall.ratioToNormal,
          gauges: opts.rainfall.gauges,
        }
        : null,
    },
    coverage: shallowCoverage(),
    note:
      'Official measurements from OVF\'s own networks, combined here. This is NOT the ' +
      'Hungarian Drought Index (HDI) published by the Aszálymonitoring service, which is ' +
      'computed differently and has no data endpoint this project can read.',
  };
}

module.exports = { assessDrought, DRY_PERCENTILE, VERY_DRY_PERCENTILE };
