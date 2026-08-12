'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { listPlants } = require('../config/powerplants');

/**
 * What a generating unit normally does, so today's output means something.
 *
 * ---------------------------------------------------------------------------
 * WHY NAMEPLATE ALONE IS THE WRONG YARDSTICK
 * ---------------------------------------------------------------------------
 * "Gönyű is at 340 MW" is a number, not information, and the two obvious ways to give it
 * a reference are both wrong on their own:
 *
 *   - Against nameplate capacity it flatters baseload and libels solar. A PV farm at 8%
 *     of nameplate is either midnight or a catastrophe, and nothing in the ratio says
 *     which.
 *   - Against a flat daily average it is worse for the same reason: averaging a solar
 *     unit's midnight zeros with its noon peak produces a figure the unit is never at,
 *     and every reading looks like a deviation from it.
 *
 * So the baseline is per unit AND per hour of day, baked from sixty days of ENTSO-E A73
 * by `npm run probe -- --unit-history`. A gas turbine that runs the evening peak is
 * compared against its own evenings; Paks is compared against a flat line, because that
 * is what a flat line looks like in this document.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CEILING IS THE OBSERVED MAXIMUM, NOT nominalP
 * ---------------------------------------------------------------------------
 * A73 carries a `nominalP` field and it came back as 0 for all 23 units, so it is not
 * usable here. The sixty-day maximum is used instead, and it is arguably the better
 * number anyway: it is what the unit has actually been asked to produce recently, rather
 * than what its plate says it could produce when new.
 *
 * It is labelled as such everywhere it appears. "78% of its recent maximum" and "78% of
 * nameplate" are different claims and only one of them is true here.
 */

const DOCUMENT_PATH = path.join(__dirname, '..', 'config', 'unit-history.json');

let cached;

function loadUnitHistory({ reload = false } = {}) {
  if (cached !== undefined && !reload) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DOCUMENT_PATH, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Compare one unit's current output with its own recent behaviour.
 *
 * @param {string} unitName   as ENTSO-E names it, e.g. PA_gép1
 * @param {number} powerMw    what it is producing now
 * @param {Date}   at         used only for the hour of day
 */
function rankUnit(unitName, powerMw, { at = new Date(), document } = {}) {
  const doc = document !== undefined ? document : loadUnitHistory();
  const entry = doc && doc[unitName];
  if (!entry || !Number.isFinite(powerMw)) return null;

  const hour = at.getUTCHours();
  const hourly = Array.isArray(entry.hourlyMeanMw) ? entry.hourlyMeanMw[hour] : null;

  return {
    unitName,
    sourceType: entry.sourceType || null,
    powerMw,
    // The two references, each named for what it is.
    hourMeanMw: Number.isFinite(hourly) ? hourly : null,
    meanMw: Number.isFinite(entry.meanMw) ? entry.meanMw : null,
    recentMaxMw: Number.isFinite(entry.maxMw) ? entry.maxMw : null,
    // Guarded on > 0: a unit that has been shut for the whole baseline has a mean of
    // zero, and a ratio to it is a division by zero dressed as a percentage.
    ratioToHour: Number.isFinite(hourly) && hourly > 0 ? round(powerMw / hourly, 3) : null,
    ratioToMax: entry.maxMw > 0 ? round(powerMw / entry.maxMw, 3) : null,
    baselineDays: entry.days,
    baselineSamples: entry.samples,
  };
}

/**
 * Every plant, with its units and how each is doing against its own record.
 *
 * A plant with no matching units gets `units: []` and a stated reason rather than being
 * silently omitted: Tisza II is the second largest thermal plant on this list and
 * publishes nothing per unit to ENTSO-E, which is a fact about the disclosure regime
 * worth showing rather than a hole to paper over.
 */
function plantUnitDetail(liveUnits, { at = new Date(), document } = {}) {
  const doc = document !== undefined ? document : loadUnitHistory();
  const byName = new Map();
  for (const u of liveUnits || []) {
    if (!u || !u.unitName) continue;
    const seen = byName.get(u.unitName);
    // One unit can appear twice with different timestamps; keep the newest.
    if (!seen || (u.timestamp || '') > (seen.timestamp || '')) byName.set(u.unitName, u);
  }

  const out = [];
  for (const plant of listPlants('operating')) {
    if (!plant.entsoeUnitPattern) {
      out.push({
        plantId: plant.id,
        units: [],
        reason: 'ez az erőmű nem közöl blokkonkénti adatot az ENTSO-E felé',
      });
      continue;
    }
    const matcher = new RegExp(plant.entsoeUnitPattern, 'i');
    const units = [...byName.values()]
      .filter((u) => matcher.test(u.unitName))
      .map((u) => ({ ...rankUnit(u.unitName, u.powerMw, { at, document: doc }), at: u.timestamp }))
      .filter((u) => u.unitName)
      .sort((a, b) => (b.powerMw || 0) - (a.powerMw || 0));

    const running = units.filter((u) => Number.isFinite(u.powerMw) && u.powerMw > 0);
    const totalMw = units.reduce((s, u) => s + (u.powerMw || 0), 0);
    const totalHourMean = units.reduce((s, u) => s + (u.hourMeanMw || 0), 0);
    const totalMax = units.reduce((s, u) => s + (u.recentMaxMw || 0), 0);

    out.push({
      plantId: plant.id,
      units,
      unitsRunning: running.length,
      unitsKnown: units.length,
      totalMw: round(totalMw, 1),
      // The plant-level comparison is the sum of its units' baselines, not a separate
      // figure: adding the parts is the only way the total and the parts can agree.
      hourMeanMw: totalHourMean > 0 ? round(totalHourMean, 1) : null,
      recentMaxMw: totalMax > 0 ? round(totalMax, 1) : null,
      ratioToHour: totalHourMean > 0 ? round(totalMw / totalHourMean, 3) : null,
      ratioToMax: totalMax > 0 ? round(totalMw / totalMax, 3) : null,
      reason: units.length ? null : 'nem érkezett blokkonkénti adat',
    });
  }
  return out;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { rankUnit, plantUnitDetail, loadUnitHistory, DOCUMENT_PATH };
