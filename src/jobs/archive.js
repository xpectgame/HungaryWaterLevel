'use strict';

const { listStations } = require('../config/stations');
const { LAKES } = require('../config/lakes');
const { computeBalance } = require('../domain/balance');
const { toCsv } = require('../lib/params');

/**
 * A day, written down once and never revised.
 *
 * THE PROBLEM THIS EXISTS FOR: the store prunes at 400 days. As built, this project is
 * a thirteen-month rolling window - it shows what is happening and keeps no evidence of
 * what happened. Anyone opening it in 2036 would find nothing at all from 2026 except
 * whatever OVF still chooses to serve, which is outside this project's control and is
 * exactly the thing that will be argued about.
 *
 * The ten-year comparisons on this site were only possible because OVF happened to keep
 * a decade. That is the whole argument for keeping our own: a record nobody preserved is
 * a record nobody can check.
 *
 * WHAT MAKES THIS AN ARCHIVE RATHER THAN A BACKUP:
 *
 *   - It is keyed by date and written once. A day already archived is never rewritten,
 *     even if the upstream later revises the numbers. A revision is a NEW fact about an
 *     old day, and overwriting would destroy the evidence that it changed - which on a
 *     public-interest dataset is the most interesting thing that can happen to it.
 *   - It records what the numbers were measured AGAINST. A ten-year median in 2026 is a
 *     different number from a ten-year median in 2036, so the archive stamps which
 *     baseline was in force. Without that, a future reader cannot reconstruct what "53%
 *     of normal" meant on the day it was published.
 *   - It is plain, boring, self-describing text. CSV and JSON, no schema server, no
 *     database dump. The format has to be readable by someone with none of this code.
 */

const SCHEMA = 1;

/**
 * Build one day's record from whatever the store holds for it.
 *
 * @param {object} store
 * @param {Date|number} day  any instant inside the UTC day to archive
 */
async function buildDay(store, day = Date.now()) {
  const at = new Date(day);
  const date = at.toISOString().slice(0, 10);
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  const toMs = fromMs + 86400000 - 1;

  const stations = listStations();
  const rows = [];

  for (const station of stations) {
    const series = await store.stationSeries(station.id, fromMs, toMs, 5000);
    const values = series.map((r) => r.flowM3s).filter(Number.isFinite);
    const levels = series.map((r) => r.waterLevelCm).filter(Number.isFinite);
    if (!series.length) continue;
    rows.push({
      date,
      station_id: station.id,
      station_name: station.name,
      river: station.river,
      role: station.role,
      samples: series.length,
      // Min, mean and max rather than a single number. A daily mean hides the day a
      // flood wave passed through, and this file has to answer questions nobody has
      // thought of yet.
      flow_min_m3s: values.length ? round(Math.min(...values), 2) : null,
      flow_mean_m3s: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 2) : null,
      flow_max_m3s: values.length ? round(Math.max(...values), 2) : null,
      level_min_cm: levels.length ? Math.min(...levels) : null,
      level_mean_cm: levels.length ? round(levels.reduce((a, b) => a + b, 0) / levels.length, 1) : null,
      level_max_cm: levels.length ? Math.max(...levels) : null,
    });
  }

  for (const lake of LAKES) {
    const series = await store.stationSeries(lake.id, fromMs, toMs, 5000);
    const levels = series.map((r) => r.waterLevelCm).filter(Number.isFinite);
    if (!series.length) continue;
    rows.push({
      date,
      station_id: lake.id,
      station_name: lake.name,
      river: 'tó',
      role: 'lake',
      samples: series.length,
      flow_min_m3s: null,
      flow_mean_m3s: null,
      flow_max_m3s: null,
      level_min_cm: levels.length ? Math.min(...levels) : null,
      level_mean_cm: levels.length ? round(levels.reduce((a, b) => a + b, 0) / levels.length, 1) : null,
      level_max_cm: levels.length ? Math.max(...levels) : null,
    });
  }

  return { date, schema: SCHEMA, rows };
}

const COLUMNS = Object.freeze([
  'date', 'station_id', 'station_name', 'river', 'role', 'samples',
  'flow_min_m3s', 'flow_mean_m3s', 'flow_max_m3s',
  'level_min_cm', 'level_mean_cm', 'level_max_cm',
]);

function dayToCsv(day) {
  return toCsv(COLUMNS, day.rows);
}

/**
 * What the day's figures were measured against.
 *
 * Stamped alongside the numbers because the reference moves. "53% of normal" is only
 * reconstructable later if the normal it used is recorded with it; a future reader
 * comparing 2026 to 2036 needs to know that the two used different baselines, and
 * whether the change is in the rivers or in the yardstick.
 */
function baselineStamp() {
  const { loadHistory, loadLakeHistory, historyCoverage } = require('../domain/flow-history');
  const flow = loadHistory();
  const lakes = loadLakeHistory();
  const anyMonths = (doc) => {
    if (!doc) return null;
    for (const entry of Object.values(doc)) {
      for (const m of entry.months || []) if (m && m.years) return m.years;
    }
    return null;
  };
  return {
    schema: SCHEMA,
    flowHistory: { present: Boolean(flow), stations: flow ? Object.keys(flow).length : 0, years: anyMonths(flow) },
    lakeHistory: { present: Boolean(lakes), lakes: lakes ? Object.keys(lakes).length : 0, years: anyMonths(lakes) },
    coverage: historyCoverage(),
    note:
      'The ten-year distributions these figures were compared against, as they stood on ' +
      'this date. They are rebaked periodically; a later archive entry may cite a different baseline.',
  };
}

/** The balance for a day, from the stored series rather than recomputed from now. */
async function balanceForDay(store, day = Date.now()) {
  const at = new Date(day);
  const date = at.toISOString().slice(0, 10);
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  const toMs = fromMs + 86400000 - 1;
  const series = await store.balanceSeries(fromMs, toMs, 5000);
  if (!series.length) return null;
  const net = series.map((r) => r.netM3s ?? r.net).filter(Number.isFinite);
  return {
    date,
    samples: series.length,
    netMeanM3s: net.length ? round(net.reduce((a, b) => a + b, 0) / net.length, 1) : null,
    netMinM3s: net.length ? round(Math.min(...net), 1) : null,
    netMaxM3s: net.length ? round(Math.max(...net), 1) : null,
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { buildDay, dayToCsv, baselineStamp, balanceForDay, COLUMNS, SCHEMA };
