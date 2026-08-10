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
 * Travel times between paired gauges, in hours.
 *
 * These are flood-wave travel times - the speed a change propagates, which is faster
 * than the water itself moves - taken from the river-kilometre distance and the
 * celerity that reach is normally quoted at. They are approximate by nature: a wave
 * moves faster in high water than in low, so each pair carries a range rather than a
 * single figure, and the payload quotes the range.
 *
 * The Danube pairs are the well-documented ones. Komárom to Budapest is a little over a
 * day; Budapest to Mohács another day and a half. The Tisza is slower per kilometre
 * because its gradient is gentler - Szolnok to Szeged is famously about two days.
 *
 * Sources for the reach distances: the riverKm already in the station registry. The
 * celerity band is the standard 2-4 km/h for the Danube's Hungarian reach and 1.5-3 km/h
 * for the middle and lower Tisza.
 */
const PAIRS = Object.freeze([
  { from: 'duna-komarom', to: 'duna-nagymaros', hours: [14, 24] },
  { from: 'duna-nagymaros', to: 'duna-budapest', hours: [6, 12] },
  { from: 'duna-budapest', to: 'duna-paks', hours: [18, 30] },
  { from: 'duna-paks', to: 'duna-mohacs', hours: [16, 28] },
  { from: 'tisza-tiszabecs', to: 'tisza-szolnok', hours: [60, 110] },
  { from: 'tisza-szolnok', to: 'tisza-szeged', hours: [36, 60] },
  { from: 'tisza-szeged', to: 'tisza-tiszasziget', hours: [2, 5] },
  { from: 'drava-ortilos', to: 'drava-dravaszabolcs', hours: [18, 30] },
]);

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
      'A két mérce közötti futásidő a folyamkilométer-távolságból és az adott szakaszra ' +
      'szokásos hullámsebességből adódik, ezért tartomány és nem egyetlen szám.',
  };
}

module.exports = { buildArrivals, describePair, dailyChange, PAIRS, NOTABLE_PCT };
