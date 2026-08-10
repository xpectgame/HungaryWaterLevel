'use strict';

const { getStation } = require('../config/stations');

/**
 * What is coming, from the only source that can honestly say so: the gauge upstream.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF A FORECAST
 * ---------------------------------------------------------------------------
 * The service catalogues AdatTipusKod 5 as `előrejelzett`, and asking for it returns
 * HTTP 500 - at every station, for both stage and discharge, one station at a time, so
 * it is not a batching problem. Codes 6 (`számított`) and 15 (`becsült`) return empty
 * series. Confirmed 2026-08-10 by `npm run probe -- --forecast`. There is no forecast to
 * fetch here, and inventing one out of a trend line would be the worst thing this
 * project could publish: a falling river extrapolated forward is a straight line that
 * knows nothing about the rain that fell in Bavaria last night.
 *
 * What CAN be said honestly is where the water already is. The Danube reaching Budapest
 * tomorrow is passing Komárom today - that is not a model, it is the same water and a
 * travel time. Flood forecasting in this basin starts from exactly this, and stating it
 * plainly gives a reader the one forward-looking thing the data supports.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This is not a flood forecast, it is not official, and it says nothing about rain that
 * has not yet fallen or about a tributary joining between the two gauges. Every string
 * this module produces is worded to make that unmistakable, and the payload carries the
 * disclaimer rather than leaving it to a frontend that might crop it.
 */

/**
 * Flood-wave celerity per river, in km/h.
 *
 * A change propagates downstream faster than the water itself moves - roughly 1.5 times
 * the mean velocity - and how much faster depends on the river's gradient and how full
 * it is. So each river gets a band rather than a number, and every travel time below is
 * derived from it and the river-kilometre distance already in the station registry.
 *
 * Derived rather than tabulated on purpose: a hand-entered hours figure that disagrees
 * with the distance between the two gauges is a typo nobody would ever notice, and it
 * would silently tell people water was arriving hours before or after it did.
 *
 * The Danube's Hungarian reach runs 4-8 km/h. The middle and lower Tisza are markedly
 * slower - a gentle gradient and a wide floodplain - at 2-3.5, which is what makes
 * Szolnok to Szeged the famous two-to-three days. The Dráva sits between them.
 */
const CELERITY_KMH = Object.freeze({
  Duna: [4, 8],
  Tisza: [2, 3.5],
  Dráva: [3.5, 6.5],
});

/**
 * Gauge pairs, upstream first.
 *
 * Adjacent gauges only. Tiszabecs to Szolnok was dropped deliberately: 410 km with the
 * Szamos, the Bodrog, the Sajó and the Hernád all joining in between is not the same
 * water arriving later, it is a different river, and a single travel time across it
 * would be a fiction.
 *
 * Tributaries do still join between the pairs that remain, which is why what this
 * produces is an indication of what is coming rather than a routed volume.
 */
const REACHES = Object.freeze([
  ['duna-komarom', 'duna-nagymaros'],
  ['duna-nagymaros', 'duna-budapest'],
  ['duna-budapest', 'duna-paks'],
  ['duna-paks', 'duna-mohacs'],
  ['tisza-szolnok', 'tisza-szeged'],
  ['tisza-szeged', 'tisza-tiszasziget'],
  ['drava-ortilos', 'drava-dravaszabolcs'],
]);

/** Distance in river kilometres, which count down towards the mouth. */
function reachKm(fromId, toId) {
  const from = getStation(fromId);
  const to = getStation(toId);
  if (!from || !to || !Number.isFinite(from.riverKm) || !Number.isFinite(to.riverKm)) return null;
  return from.riverKm - to.riverKm;
}

const PAIRS = Object.freeze(
  REACHES.map(([from, to]) => {
    const km = reachKm(from, to);
    const band = CELERITY_KMH[getStation(from).river];
    if (km === null || !band) {
      throw new Error(`arrival: cannot derive a travel time for ${from} -> ${to}`);
    }
    // Fast celerity gives the earliest arrival, slow gives the latest.
    return Object.freeze({
      from,
      to,
      km,
      hours: Object.freeze([Math.round(km / band[1]), Math.round(km / band[0])]),
    });
  }),
);

/** How much of a change is worth telling someone about. */
const NOTABLE_PCT = 8;

/** Whole hours between two ISO timestamps. */
function hoursBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / 3600000;
}

/**
 * The change at the upstream gauge over the last day.
 *
 * Measured against the sample nearest 24 hours before the newest one rather than against
 * the oldest row held - an instance holding six hours of history would otherwise report a
 * six-hour change as a daily one, which is the same trap the events feed had to avoid.
 */
function dailyChange(series, key = 'flowM3s') {
  const usable = (series || [])
    .filter((row) => row && Number.isFinite(row[key]) && row.timestamp)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (usable.length < 2) return null;

  const latest = usable[usable.length - 1];
  const target = Date.parse(latest.timestamp) - 24 * 3600 * 1000;

  let reference = null;
  let bestGap = Infinity;
  for (const row of usable.slice(0, -1)) {
    const gap = Math.abs(Date.parse(row.timestamp) - target);
    if (gap < bestGap) {
      bestGap = gap;
      reference = row;
    }
  }

  // Nothing within six hours of a day ago is not a daily change, it is a shorter one
  // wearing the label.
  if (!reference || bestGap > 6 * 3600 * 1000) return null;

  const from = reference[key];
  const to = latest[key];
  if (!(from > 0)) return null;

  return {
    fromValue: from,
    toValue: to,
    changePct: Math.round(((to - from) / from) * 1000) / 10,
    overHours: Math.round(hoursBetween(reference.timestamp, latest.timestamp)),
    at: latest.timestamp,
  };
}

function describePair(pair, historyByStation, now) {
  const upstream = getStation(pair.from);
  const downstream = getStation(pair.to);
  if (!upstream || !downstream) return null;

  const change = dailyChange(historyByStation[pair.from]);
  if (!change) return null;

  const [minHours, maxHours] = pair.hours;
  const measuredAt = Date.parse(change.at);
  // The clock starts when the upstream reading was taken, not now: a reading three hours
  // old means the water has already been travelling for three hours.
  const earliest = new Date(measuredAt + minHours * 3600 * 1000);
  const latest = new Date(measuredAt + maxHours * 3600 * 1000);

  const rising = change.changePct > 0;
  const notable = Math.abs(change.changePct) >= NOTABLE_PCT;
  const alreadyArrived = latest.getTime() < now;

  return {
    upstream: { id: upstream.id, name: upstream.name, river: upstream.river },
    downstream: { id: downstream.id, name: downstream.name, river: downstream.river },
    travelHours: { min: minHours, max: maxHours },
    reachKm: pair.km,
    change: {
      pct: change.changePct,
      fromM3s: Math.round(change.fromValue * 10) / 10,
      toM3s: Math.round(change.toValue * 10) / 10,
      overHours: change.overHours,
      measuredAt: change.at,
    },
    direction: rising ? 'rising' : 'falling',
    notable,
    arrivesFrom: earliest.toISOString(),
    arrivesUntil: latest.toISOString(),
    alreadyArrived,
    text: notable
      ? `${upstream.name} ${rising ? 'emelkedő' : 'apadó'} vize (${change.changePct > 0 ? '+' : ''}${change.changePct}% ` +
        `${change.overHours} óra alatt) nagyjából ${minHours}-${maxHours} óra múlva ér ${downstream.name} alá.`
      : `${upstream.name} felől nem érkezik érdemi változás: ${change.changePct > 0 ? '+' : ''}${change.changePct}% ` +
        `${change.overHours} óra alatt.`,
  };
}

/**
 * Build the arrival payload.
 *
 * Pure over history the caller already has, so no extra upstream call: the events feed
 * loads the same per-station series and this rides along on it.
 */
function buildArrivals({ historyByStation = {}, now = Date.now() } = {}) {
  const arrivals = PAIRS.map((pair) => describePair(pair, historyByStation, now)).filter(Boolean);

  return {
    count: arrivals.length,
    // Biggest change first: "what is coming" is answered by the largest one, not by the
    // river that happens to be listed first.
    arrivals: arrivals.sort((a, b) => Math.abs(b.change.pct) - Math.abs(a.change.pct)),
    notable: arrivals.filter((a) => a.notable && !a.alreadyArrived).length,
    disclaimer:
      'Ez nem hivatalos előrejelzés. A folyásirányban feljebb lévő mérce mai adatából és a ' +
      'hullám szokásos futásidejéből számolt becslés: azt mutatja, hol tart most a víz, nem ' +
      'azt, hogy mennyi eső fog esni. Hivatalos vízjelzés: hidroinfo.hu.',
    method:
      'A két mérce közötti futásidő a folyamkilométer-távolságból és az adott folyóra ' +
      'szokásos hullámsebességből adódik, ezért tartomány és nem egyetlen szám. A két ' +
      'mérce között mellékfolyók is beletorkollnak, így ez irány és nem mennyiség.',
  };
}

module.exports = { buildArrivals, describePair, dailyChange, PAIRS, CELERITY_KMH, NOTABLE_PCT };
