'use strict';

const { getStation } = require('../config/stations');
const { rankFlow } = require('./flow-history');

/**
 * The events feed, turned into something a newsroom can subscribe to.
 *
 * This exists because the feed on the page answers "what is happening" only for someone
 * who visits the page. A newsroom does not visit; it subscribes. So the same facts go out
 * as Atom, and the whole design problem is not what to say - the events domain already
 * decided that - but WHEN TO SAY IT AGAIN.
 *
 * STABLE IDENTITY IS THE ENTIRE FEATURE.
 *
 * The poller runs every fifteen minutes. A river that has been low for nine days is still
 * low at the next poll, and an id derived from "now" would emit a fresh entry every time -
 * 96 notifications a day about one unchanging fact. Every reader would unsubscribe within
 * a day, and rightly.
 *
 * So each alert's id is derived from what makes it THAT alert and nothing else:
 *
 *   flood-grade   kind + station + grade + the day it was crossed. A crossing is a
 *                 discrete event; crossing back and forth is genuinely two entries.
 *   low-run       kind + station + when the run STARTED. The entry's text changes as the
 *                 days accumulate, but it stays one entry for one unbroken run.
 *   record-low    kind + station + year-month. An ongoing condition, not a repeating
 *                 event: being below the ten-year record on the 3rd and again on the 4th
 *                 is one story.
 *   step-change   kind + station + the hour it happened. Genuinely discrete.
 *
 * `at` is what the entry says happened and when; `updated` is when we last saw it still
 * true. Feed readers key on id and show `updated`, so an ongoing run stays one item that
 * quietly refreshes rather than a stack of duplicates.
 */

const LEVELS = Object.freeze({ 3: 'emergency', 2: 'warning', 1: 'notice' });

/**
 * A station reading below everything in its own ten-year record for this month.
 *
 * The alert this project could not raise before the archive was baked, and the one most
 * worth raising: "below 60% of the annual mean" is true on half these rivers every August
 * and is not news. "Lower than any August day in ten years" is.
 */
function recordLow(station, reading, now, document) {
  if (!reading || !Number.isFinite(reading.flowM3s)) return null;
  // `document` is threaded through rather than left to rankFlow's file read so a test can
  // state the record it is testing against. Without it the only way to test this is to
  // assert against whatever the baked file happens to hold today, which is a test that
  // changes its mind every time the archive is re-baked.
  const rank = rankFlow(station.id, reading.flowM3s, { at: reading.timestamp || now, document });
  if (!rank || !rank.belowRecord) return null;
  // Five years is the floor for saying "in N years" at all - below that the phrase
  // promises a record the data does not have.
  if (!(rank.years >= 5)) return null;

  const month = new Date(reading.timestamp || now).toISOString().slice(0, 7);
  return {
    kind: 'record-low',
    at: reading.timestamp || new Date(now).toISOString(),
    // Ranked with a flood grade rather than below it. A border section below anything in
    // its record is the same order of news as a flood alert, in the other direction.
    severity: 3,
    stationId: station.id,
    id: `record-low:${station.id}:${month}`,
    title: `${station.name}: kevesebb víz, mint bármelyik ${monthAdj(rank.month)} napon az elmúlt ${rank.years} évben`,
    detail:
      `Most ${round(reading.flowM3s)} m³/s. Az eddigi mélypont ${rank.recordLow.value} m³/s volt ` +
      `${rank.recordLow.day}-én, a havi medián ${rank.medianM3s} m³/s. ` +
      `${rank.years} év, ${rank.days} nap adatából.`,
    evidence: {
      currentM3s: round(reading.flowM3s),
      previousRecordM3s: rank.recordLow.value,
      previousRecordDay: rank.recordLow.day,
      medianM3s: rank.medianM3s,
      years: rank.years,
      days: rank.days,
      month: rank.month,
    },
  };
}

const MONTH_ADJ = ['januári', 'februári', 'márciusi', 'áprilisi', 'májusi', 'júniusi',
  'júliusi', 'augusztusi', 'szeptemberi', 'októberi', 'novemberi', 'decemberi'];
const monthAdj = (m) => MONTH_ADJ[m - 1] || '';

/**
 * The id an event keeps for as long as it is the same event.
 *
 * Derived per kind, never from the current time - see the note at the top. An unknown
 * kind falls back to the hour, which re-emits at most once an hour rather than every
 * poll: wrong, but bounded, and a new kind arriving should not spam anyone before
 * someone gets round to giving it a rule.
 */
function identify(event) {
  if (event.id) return event.id;
  const who = event.stationId || event.lakeId || 'system';
  const e = event.evidence || {};

  switch (event.kind) {
    case 'flood-grade':
      return `flood-grade:${who}:${e.grade ?? 'none'}:${day(event.at)}`;
    case 'low-run':
      // The run's start, so a run that has been going nine days is the same entry it was
      // on day three - with a longer title.
      return `low-run:${who}:${e.sinceMs ? new Date(e.sinceMs).toISOString().slice(0, 13) : day(event.at)}`;
    case 'lake-change':
      return `lake-change:${who}:${day(event.at)}`;
    default:
      return `${event.kind}:${who}:${hour(event.at)}`;
  }
}

const day = (iso) => String(iso || '').slice(0, 10);
const hour = (iso) => String(iso || '').slice(0, 13);

/**
 * @param {object} built            the output of buildEvents()
 * @param {object} [readings]       stationId -> latest reading, for the record-low check
 * @param {object} [opts]
 * @param {number} [opts.minSeverity=2]  notices are not worth a notification
 */
function buildAlerts(built = {}, readings = {}, opts = {}) {
  const now = opts.now || Date.now();
  const minSeverity = opts.minSeverity === undefined ? 2 : opts.minSeverity;
  const out = [];

  // Record lows first: they are computed here rather than in events.js because they need
  // the baked archive, which events.js has no business loading.
  for (const [stationId, reading] of Object.entries(readings)) {
    const station = getStation(stationId);
    if (!station) continue;
    const alert = recordLow(station, reading, now, opts.historyDocument);
    if (alert) out.push(alert);
  }

  for (const event of built.events || []) {
    out.push({ ...event, id: identify(event) });
  }

  const alerts = out
    .filter((a) => (a.severity || 0) >= minSeverity)
    // One entry per id. A station can be both below its record and nine days into a low
    // run, and those are two different statements - but the same statement must not
    // arrive twice because two code paths produced it.
    .filter(dedupeById())
    .sort((a, b) => b.severity - a.severity || Date.parse(b.at) - Date.parse(a.at))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      level: LEVELS[a.severity] || 'notice',
      severity: a.severity,
      stationId: a.stationId || null,
      at: a.at,
      // When we last confirmed it. Distinct from `at` on purpose: a nine-day run happened
      // nine days ago and is still true now, and a reader needs both numbers.
      updated: new Date(now).toISOString(),
      title: a.title,
      detail: a.detail,
      evidence: a.evidence || {},
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    count: alerts.length,
    minSeverity,
    alerts,
    note:
      'Minden riasztás saját mérésből származik, és közli a számokat, amikből következik. ' +
      'Az azonosító addig változatlan, amíg ugyanarról az eseményről van szó, ' +
      'így egy tartósan fennálló állapot nem küld új értesítést minden lekérdezéskor.',
  };
}

function dedupeById() {
  const seen = new Set();
  return (a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  };
}

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { buildAlerts, identify, recordLow, LEVELS };
