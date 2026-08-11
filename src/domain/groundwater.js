'use strict';

const { listWells, wellCoverage, WELL_KIND } = require('../config/wells');
const { rankWell, wellStatus } = require('./flow-history');

/**
 * The national groundwater picture, assembled without ever averaging a groundwater level.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT THIS MODULE IS BUILT AROUND
 * ---------------------------------------------------------------------------
 * There is no such thing as "the Hungarian groundwater level" in this data. Each well
 * reports a depth against its own datum, in whatever unit that well happens to use - the
 * network mixes metres and centimetres, some wells count depth downwards as positive, and
 * for a handful the live feed and the archive disagree with each other. Averaging those
 * numbers would produce a figure with a decimal point and no referent, and it would look
 * authoritative on a chart.
 *
 * So the aggregate here is a COUNT, not a mean: how many wells are currently sitting low
 * against their own ten-year record for this calendar month. Every input to that count is
 * a within-well comparison, so no unit ever has to be reconciled with any other, and the
 * result survives the fact that the units are a mess.
 *
 *     "31 of 89 comparable wells are below their own ten-year August quartile"
 *
 * is a real national statement. "The groundwater is 47 cm lower than usual" is not one,
 * and this module is arranged so that the second sentence cannot be constructed from it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GAPS ARE IN THE PAYLOAD
 * ---------------------------------------------------------------------------
 * A well can drop out of the count for four different reasons and they do not mean the
 * same thing. A missing archive is a gap in what OVF published years ago; a reading that
 * is not commensurable with its own archive is a gap that opened in the feed recently and
 * is worth someone looking at. Both are reported with their counts, because a denominator
 * that quietly shrinks is how a drought signal turns into a sampling artefact.
 */

/** Percentile at or below which a well counts as low. The bottom quarter of its decade. */
const LOW_PERCENTILE = 25;
/** And the bottom twentieth, where "unusually" starts meaning something. */
const VERY_LOW_PERCENTILE = 5;

/**
 * @param {Map|object} readings  wellId -> { value, at } (or a bare number)
 * @param {object} [opts]
 * @param {Date|number} [opts.at]        which calendar month to judge against
 * @param {object} [opts.document]       inject the baked history
 * @param {number} [opts.maxAgeDays=45]  a reading older than this is not "now"
 */
function assess(readings, opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date();
  const maxAgeDays = opts.maxAgeDays === undefined ? 45 : opts.maxAgeDays;
  const get = (id) => (readings instanceof Map ? readings.get(id) : readings && readings[id]);

  const wells = [];
  const statuses = {};
  const bump = (code) => { statuses[code] = (statuses[code] || 0) + 1; };

  for (const well of listWells()) {
    const raw = get(well.id);
    const reading = raw && typeof raw === 'object' ? raw : { value: raw, at: null };
    const value = Number.isFinite(reading.value) ? reading.value : null;
    const readAt = reading.at ? new Date(reading.at) : null;

    // Age is checked before the ranking rather than after. A well last read in April
    // still ranks perfectly well against April's distribution and would join the count
    // as if it were current - which is how a shrinking network turns into a trend.
    const ageDays = readAt ? (at - readAt) / 86400000 : null;
    const stale = ageDays !== null && ageDays > maxAgeDays;

    const status = value === null ? 'no-reading'
      : stale ? 'stale'
        : wellStatus(well.id, value, { at, document: opts.document });
    bump(status);

    const rank = status === 'ok' ? rankWell(well.id, value, { at, document: opts.document }) : null;

    wells.push({
      id: well.id,
      name: well.name,
      settlement: well.settlement,
      vizig: well.vizig,
      lat: well.lat,
      lon: well.lon,
      // Carried, never compared. Someone rebuilding the archive in ten years needs the
      // number that was actually served; the site is expected to show the rank instead.
      value,
      at: readAt ? readAt.toISOString() : null,
      ageDays: ageDays === null ? null : Math.round(ageDays),
      status,
      rank,
    });
  }

  const ranked = wells.filter((w) => w.rank);
  const atOrBelow = (limit) => ranked.filter((w) => w.rank.percentile !== null && w.rank.percentile <= limit).length;

  return {
    kind: WELL_KIND.label,
    kindNote: WELL_KIND.note,
    month: at.getUTCMonth() + 1,
    wells,
    summary: {
      registered: wells.length,
      comparable: ranked.length,
      low: atOrBelow(LOW_PERCENTILE),
      veryLow: atOrBelow(VERY_LOW_PERCENTILE),
      recordLow: ranked.filter((w) => w.rank.belowRecord).length,
      high: ranked.filter((w) => w.rank.percentile !== null && w.rank.percentile >= 75).length,
      statuses,
      lowPercentile: LOW_PERCENTILE,
      veryLowPercentile: VERY_LOW_PERCENTILE,
      note:
        'A count of wells sitting low against their own ten-year record for this calendar ' +
        'month, not an average of levels. Groundwater levels in this network are depths ' +
        "against each well's own datum in mixed units and cannot be averaged or compared " +
        'between wells.',
    },
    coverage: wellCoverage(),
  };
}

module.exports = { assess, LOW_PERCENTILE, VERY_LOW_PERCENTILE };
