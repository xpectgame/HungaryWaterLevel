'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { loadHistory, loadLakeHistory, loadYearly, percentileWithin } = require('./flow-history');

/**
 * What happened, in this record, from where we are now.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A FORECAST, AND THE DISTINCTION IS THE POINT
 * ---------------------------------------------------------------------------
 * The reader's question is "when will the Balaton fill back up". A forecast would answer
 * it. This project cannot forecast and must not pretend to: the upstream publishes none
 * (AdatTipusKod 5 answers HTTP 500), nothing here ingests a weather model, and a lake's
 * refill depends almost entirely on precipitation months from now, which is exactly the
 * thing nobody in this pipeline knows.
 *
 * What a ten-year record CAN answer, truthfully, is a different question that happens to
 * be nearly as useful:
 *
 *     "The last time the Balaton was this low in August, when did it come back?"
 *
 * That is a statement about 2022 and 2019, not about 2026. It is checkable. It carries
 * its own uncertainty visibly, because it is reported year by year and the years disagree
 * with each other. And when the years disagree wildly, the reader can see that too, which
 * is more honest than a single number with an error bar nobody reads.
 *
 * ---------------------------------------------------------------------------
 * THE TWO LEGS, AND WHY BOTH ARE NEEDED
 * ---------------------------------------------------------------------------
 * 1. THE SEASONAL PATH, from every year pooled. "From August, this water normally falls
 *    another 14 cm to November and starts rising in January." Ten years of medians, so
 *    it is the robust half - a lake's annual cycle is a real, repeating thing. It says
 *    WHEN refilling happens, which is most of what the question is asking.
 *
 * 2. THE ANALOGUE YEARS, kept apart. "2022 was this low; it was back in the normal band
 *    by the following March. 2019 took until December." Small n, always stated, never
 *    averaged. This says HOW LONG it took when the starting point was as bad as now,
 *    which the pooled median cannot say because pooling throws the years away.
 *
 * Leg 1 without leg 2 describes an average year and today is not one. Leg 2 without leg 1
 * is two anecdotes. Together they are an answer with its own error bars attached.
 *
 * ---------------------------------------------------------------------------
 * WHY WELLS ARE NOT HERE
 * ---------------------------------------------------------------------------
 * Rivers and lakes agree that a bigger number is more water. Groundwater does not: the
 * shallow network reports DEPTH TO WATER, where bigger means drier, and the confined
 * wells do not even agree with each other about the sign. Every "recovered" test in this
 * file is a `>=`, and pointing it at a well would report a drought as a recovery. The
 * inversion lives in flow-history's rankShallow and is not reproduced here; wells are
 * simply out of scope, by refusal rather than by omission.
 */

const HORIZON_MONTHS = 12;

/**
 * What counts as "back to normal": the 25th percentile of the target calendar month.
 *
 * Not the median. Waiting for the median means waiting for an ordinary year, and a
 * reader asking when the water comes back is asking when it stops being unusual, not
 * when it becomes exactly average. p25 is the bottom of the normal band the rest of this
 * site already uses (flow-history's BANDS put 'low' below 25), so "back to normal" here
 * means the same thing as "normal" everywhere else on the page.
 */
const RECOVERY_QUANTILE_INDEX = 2; // p[2] === p25

/**
 * How close a past year has to be to count as the same situation.
 *
 * Rivers get a fraction, lakes get centimetres, and the difference is not fussiness. A
 * river's discharge is a ratio scale - zero means no water - so "within 25%" means
 * something. A lake level is measured against an arbitrary gauge datum: the Balaton's
 * zero is a mark on a wall at Siófok, not an empty lake. Twenty-five per cent of 80 cm
 * is 20 cm, which on the Balaton is the difference between a dry year and a crisis,
 * while 25% of a level that happened to be recorded near zero would be nothing at all.
 *
 * So lakes use an absolute window derived from the month's own spread - half its
 * interquartile range, floored so that a very stable month still admits some neighbours.
 */
const RIVER_TOLERANCE = 0.25;
const LAKE_TOLERANCE_FLOOR_CM = 8;
const MAX_ANALOGUES = 4;

const LAKE_YEARLY_PATH = path.join(__dirname, '..', 'config', 'lake-yearly.json');
let cachedLakeYearly;

function loadLakeYearly({ reload = false } = {}) {
  if (cachedLakeYearly !== undefined && !reload) return cachedLakeYearly;
  try {
    cachedLakeYearly = JSON.parse(fs.readFileSync(LAKE_YEARLY_PATH, 'utf8'));
  } catch {
    cachedLakeYearly = null;
  }
  return cachedLakeYearly;
}

const KINDS = Object.freeze({
  river: { unit: 'm3/s', history: loadHistory, yearly: loadYearly },
  lake: { unit: 'cm', history: loadLakeHistory, yearly: loadLakeYearly },
});

/**
 * The outlook for one river station or one lake.
 *
 * @param {'river'|'lake'} kind
 * @param {string} id       station or lake id
 * @param {number} value    what it is reading now
 * @returns {object|null}   null when the record is missing or too thin to say anything
 */
function outlookFor(kind, id, value, opts = {}) {
  const spec = KINDS[kind];
  if (!spec || !Number.isFinite(value)) return null;

  const history = opts.history !== undefined ? opts.history : spec.history();
  const yearly = opts.yearly !== undefined ? opts.yearly : spec.yearly();
  const months = history && history[id] && history[id].months;
  if (!Array.isArray(months)) return null;

  const at = opts.at ? new Date(opts.at) : new Date();
  const month = at.getUTCMonth();
  const here = months[month];

  const normal = seasonalPath(months, month);
  const analogues = analogueYears(kind, id, value, month, { yearly, months });

  return {
    id,
    kind,
    unit: spec.unit,
    month: month + 1,
    value: round(value, kind === 'river' ? 1 : 0),
    // Where today sits in this month's own decade. Carried so the consumer can say
    // "this is the low end of ten Augusts" without ranking it a second time.
    percentile: here ? percentileWithin(value, here) : null,
    normalNow: here && Array.isArray(here.p) ? here.p[RECOVERY_QUANTILE_INDEX] : null,
    belowNormal: here && Array.isArray(here.p) ? value < here.p[RECOVERY_QUANTILE_INDEX] : null,
    normal,
    analogues,
    horizonMonths: HORIZON_MONTHS,
    note:
      'Ez nem előrejelzés: a múlt tíz év mérései, nem a jövő. ' +
      'A felsővízügyi szolgálat előrejelzést nem publikál gépi felületen.',
  };
}

/**
 * The ordinary year, from this month forward, in medians.
 *
 * Wraps past December on purpose. A drought question asked in August is answered in
 * February, and a path that stopped at the end of the calendar year would stop exactly
 * before the part the reader wants. The pooled document has no year in it at all - each
 * month is ten years of that month - so wrapping is not a claim about which year, only
 * about which season.
 */
function seasonalPath(months, from) {
  const start = months[from];
  if (!start || !Array.isArray(start.p)) return null;
  const base = start.p[3];

  const path = [];
  for (let ahead = 1; ahead <= HORIZON_MONTHS; ahead += 1) {
    const m = (from + ahead) % 12;
    const rec = months[m];
    if (!rec || !Array.isArray(rec.p)) {
      path.push({ monthsAhead: ahead, month: m + 1, median: null, delta: null, deltaPct: null });
      continue;
    }
    path.push({
      monthsAhead: ahead,
      month: m + 1,
      median: rec.p[3],
      delta: round(rec.p[3] - base, 1),
      // A percentage of a lake level on an arbitrary datum is meaningless, so it is
      // offered only where the scale has a real zero.
      deltaPct: base > 0 ? round(((rec.p[3] - base) / base) * 100, 0) : null,
    });
  }

  const known = path.filter((p) => Number.isFinite(p.median));
  let lowest = null;
  for (const p of known) if (!lowest || p.median < lowest.median) lowest = p;

  // The first month along the path that is higher than the month before it AND stays at
  // or above that level for the following month too. A single month's blip is not the
  // turn of the season, and a reader told "it starts rising in October" because of one
  // wet October in 2019 has been misled.
  let turns = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const prev = i === 0 ? base : path[i - 1].median;
    const cur = path[i].median;
    const next = path[i + 1].median;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || !Number.isFinite(next)) continue;
    if (cur > prev && next >= cur) { turns = path[i]; break; }
  }

  // When the ordinary year gets back to where it is standing now. "It starts rising in
  // October" is true of the Balaton and understates it badly - October is +2 cm, and the
  // level does not see this August's median again until December. This is the concrete
  // half of "when does it refill", and it is a property of the pooled record, so it
  // carries none of the small-n weakness the analogue years do.
  const backToHere = known.find((p) => p.median >= base) || null;

  return {
    fromMedian: base,
    path,
    lowestAhead: lowest ? { monthsAhead: lowest.monthsAhead, month: lowest.month, median: lowest.median } : null,
    risesFrom: turns ? { monthsAhead: turns.monthsAhead, month: turns.month } : null,
    backToHereAt: backToHere
      ? { monthsAhead: backToHere.monthsAhead, month: backToHere.month, median: backToHere.median }
      : null,
  };
}

/**
 * The years that started here, and what each of them did next.
 *
 * Chains across the year boundary by walking into the following year's record, which is
 * the whole reason the yearly documents are kept per year: a low August recovers in
 * February, and February belongs to a different key.
 */
function analogueYears(kind, id, value, month, { yearly, months }) {
  const byYear = yearly && yearly[id];
  if (!byYear) return { available: false, years: [], yearsConsidered: 0 };

  const tolerance = toleranceFor(kind, value, months[month]);
  const candidates = [];
  let below = 0;
  let comparable = 0;

  for (const [yearKey, series] of Object.entries(byYear)) {
    const then = Array.isArray(series) ? series[month] : null;
    if (!Number.isFinite(then)) continue;
    comparable += 1;
    if (value < then) below += 1;
    const distance = Math.abs(then - value);
    if (distance > tolerance) continue;
    candidates.push({ year: Number(yearKey), valueThen: then, distance: round(distance, 1) });
  }

  candidates.sort((a, b) => a.distance - b.distance || b.year - a.year);

  const startBar = months[month] && Array.isArray(months[month].p)
    ? months[month].p[RECOVERY_QUANTILE_INDEX]
    : null;

  const years = candidates.slice(0, MAX_ANALOGUES).map((c) => {
    // A year that was already in the normal band has nothing to recover from, and
    // reporting "back to normal after 1 month" for it would be true, meaningless, and
    // read by every reader as a recovery time. Such years still carry their path - the
    // reader can see what an ordinary year did - but no recovery is claimed.
    const startedBelow = Number.isFinite(startBar) ? c.valueThen < startBar : null;
    const walk = walkForward(byYear, c.year, month, months, c.valueThen);
    return { ...c, startedBelow, ...walk, recovered: startedBelow ? walk.recovered : null };
  });

  return {
    available: true,
    tolerance: round(tolerance, 1),
    toleranceKind: kind === 'river' ? 'relative' : 'absolute',
    yearsConsidered: comparable,
    // "Lower than every year in this record" is a strong true sentence, and it is
    // exactly the case where no analogue exists - so the reason for an empty list is
    // reported rather than left to be guessed from the absence.
    lowerThanAll: comparable > 0 && below === comparable,
    higherThanAll: comparable > 0 && below === 0,
    years,
    recovery: summariseRecovery(years),
  };
}

/**
 * How long it took, across the analogue years - as a spread, never as an average.
 *
 * Three years that took 1, 3 and 14 months did not take "six months on average". They
 * took one, three and fourteen months, and the honest summary is the range plus the
 * count, which is what this returns. `unknown` is kept separate from `never`: a year
 * whose path runs off the end of the baked record has not failed to recover, it simply
 * has not been measured that far, and collapsing the two would turn missing data into a
 * pessimistic claim.
 */
function summariseRecovery(years) {
  const started = years.filter((y) => y.startedBelow);
  if (!started.length) return { n: 0, recovered: 0, never: 0, unknown: 0, earliest: null, latest: null, months: [] };

  const done = started.filter((y) => y.recovered);
  const unknown = started.filter((y) => !y.recovered && y.truncated).length;
  const monthsTaken = done.map((y) => y.recovered.monthsAhead).sort((a, b) => a - b);

  return {
    n: started.length,
    recovered: done.length,
    never: started.length - done.length - unknown,
    unknown,
    earliest: monthsTaken.length ? monthsTaken[0] : null,
    latest: monthsTaken.length ? monthsTaken[monthsTaken.length - 1] : null,
    months: monthsTaken,
    // Which calendar month each one came back in - the part that answers "when",
    // as opposed to "how long".
    calendarMonths: done.map((y) => y.recovered.month),
  };
}

/**
 * One analogue year, month by month, until it is back in the normal band.
 *
 * Stops early when the following year is missing from the record rather than treating a
 * gap as a flat line: the most recent analogue is usually last year, and last year's
 * path runs out in December because this year has not been baked yet. That is a shorter
 * answer, not a wrong one, and `truncated` says which.
 */
function walkForward(byYear, year, fromMonth, months, startValue) {
  const steps = [];
  let recovered = null;
  let truncated = false;

  for (let ahead = 1; ahead <= HORIZON_MONTHS; ahead += 1) {
    const total = fromMonth + ahead;
    const y = year + Math.floor(total / 12);
    const m = total % 12;
    const series = byYear[String(y)];
    if (!Array.isArray(series)) { truncated = true; break; }
    const v = series[m];
    if (!Number.isFinite(v)) { steps.push({ monthsAhead: ahead, month: m + 1, year: y, value: null }); continue; }

    const rec = months[m];
    const bar = rec && Array.isArray(rec.p) ? rec.p[RECOVERY_QUANTILE_INDEX] : null;
    // TWO conditions, and the second one is not redundant.
    //
    // The normal band is the p25 of a ten-year record that CONTAINS the drought years,
    // so in a run of dry summers the bar sinks towards the crisis it is supposed to
    // measure. The Velencei-tó in 2021 fell from 80 cm in August to 74 cm in September
    // and that 74 cleared September's p25, so a bar-only test reported the lake as
    // recovered while it was still emptying. It had not recovered; the yardstick had.
    //
    // Requiring the level to be back ABOVE WHERE IT STARTED as well as inside the band
    // is what makes this answer the question actually asked - when did it fill back up -
    // rather than when did it stop being unusual for its decade.
    const inBand = Number.isFinite(bar) ? v >= bar : null;
    const risen = Number.isFinite(startValue) ? v >= startValue : true;
    const back = inBand === null ? null : inBand && risen;
    steps.push({ monthsAhead: ahead, month: m + 1, year: y, value: v, normalBar: bar, back });
    if (back && !recovered) {
      recovered = { monthsAhead: ahead, month: m + 1, year: y, value: v, from: startValue, normalBar: bar };
    }
  }

  return { steps, recovered, truncated: truncated && !recovered };
}

function toleranceFor(kind, value, record) {
  if (kind === 'river') return Math.abs(value) * RIVER_TOLERANCE;
  const p = record && Array.isArray(record.p) ? record.p : null;
  const iqr = p ? Math.abs(p[4] - p[2]) : 0;
  return Math.max(LAKE_TOLERANCE_FLOOR_CM, iqr / 2);
}

function round(v, digits) {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = {
  outlookFor,
  seasonalPath,
  loadLakeYearly,
  HORIZON_MONTHS,
  RECOVERY_QUANTILE_INDEX,
  LAKE_YEARLY_PATH,
};
