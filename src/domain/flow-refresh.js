'use strict';

/**
 * Fold a fresh window of daily discharge into the baked flow archive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * flow-daily.json and flow-yearly.json come from the ten-year bake, which is roughly 300
 * full-year requests against someone else's public service and takes the better part of
 * half an hour. It was run by hand, so the archive ended wherever the last run did: on
 * 17 August 2026, which left "Rosszabb, mint 2022?" without August or September and its
 * running-month card empty for six weeks.
 *
 * Re-running the whole bake every day to add one day would be absurd. Instead a daily job
 * fetches the last few weeks only - one request per gauge - and this module merges them in:
 * the new days overwrite the archive's, and every calendar month those days touch gets its
 * median recomputed under the same rule the bake uses. The ten-year percentile envelopes
 * (flow-history.json) are not touched here; they describe past years, and a monthly full
 * re-bake keeps them current.
 *
 * Pure: takes the documents and the fetched window, returns new documents. No I/O, so
 * the merge can be tested without a network and without a runner.
 */

/** The bake publishes a month once this many of its days are in - same as MIN_DAYS_IN_MONTH there. */
const MIN_DAYS_IN_MONTH = 20;

/** Linear-interpolated percentile over a sorted array - the bake's percentileOf, exactly. */
function percentileOf(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param daily   station -> year -> 'MM-DD' -> daily mean (the baked flow-daily.json)
 * @param yearly  station -> year -> [12 monthly medians | null] (flow-yearly.json)
 * @param fresh   station -> 'YYYY-MM-DD' -> daily mean, the newly fetched window
 * @returns { daily, yearly, touched } - new documents (inputs are not mutated) and the
 *          (station, year, month) triples whose median was recomputed.
 */
function mergeFlowWindow({ daily = {}, yearly = {}, fresh = {} } = {}) {
  const outDaily = { ...daily };
  const outYearly = { ...yearly };
  const touched = [];

  for (const [id, days] of Object.entries(fresh || {})) {
    const byYear = { ...(outDaily[id] || {}) };
    const copiedYears = new Set();
    const touchedMonths = new Set();

    for (const [iso, value] of Object.entries(days || {})) {
      // A negative discharge is an instrument fault, not backflow - the bake drops it too.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(value) || value < 0) continue;
      const year = iso.slice(0, 4);
      if (!copiedYears.has(year)) {
        byYear[year] = { ...(byYear[year] || {}) };
        copiedYears.add(year);
      }
      // One decimal, as the bake stores it: the rating curve carries 5-10% error, so a
      // second decimal is noise.
      byYear[year][iso.slice(5)] = round1(value);
      touchedMonths.add(iso.slice(0, 7));
    }
    if (!copiedYears.size) continue;
    outDaily[id] = byYear;

    const yearlyById = { ...(outYearly[id] || {}) };
    for (const ym of [...touchedMonths].sort()) {
      const year = ym.slice(0, 4);
      const mm = ym.slice(5, 7);
      const values = Object.entries(byYear[year] || {})
        .filter(([md, v]) => md.startsWith(`${mm}-`) && Number.isFinite(v))
        .map(([, v]) => v)
        .sort((a, b) => a - b);
      const existed = Array.isArray(yearlyById[year]);
      const series = existed ? yearlyById[year].slice() : new Array(12).fill(null);
      // A month that has not mostly happened is not that month - the same guard as the
      // bake, so a refreshed archive and a fully re-baked one agree on what is published.
      series[Number(mm) - 1] = values.length >= MIN_DAYS_IN_MONTH ? round2(percentileOf(values, 50)) : null;
      if (existed || series.some((v) => v !== null)) yearlyById[year] = series;
      touched.push({ station: id, year: Number(year), month: Number(mm) - 1, days: values.length });
    }
    outYearly[id] = yearlyById;
  }

  return { daily: outDaily, yearly: outYearly, touched };
}

module.exports = { mergeFlowWindow, percentileOf, MIN_DAYS_IN_MONTH };
