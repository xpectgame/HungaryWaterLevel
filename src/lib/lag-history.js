'use strict';

const { listStations } = require('../config/stations');

/**
 * Prefetch the samples the travel-time-lagged balance needs, and hand back a plain
 * synchronous lookup.
 *
 * `computeBalance` is deliberately synchronous - it is arithmetic, and making it async
 * would push promises through every caller for no benefit. But a lagged balance wants
 * each inflow station at a different point in the past, which against a remote database
 * would be twenty serial round trips buried inside the arithmetic.
 *
 * Fetching them up front, in parallel, keeps both properties: the domain layer stays
 * pure, and the I/O happens once at the edge where it can be seen.
 */
async function loadLagHistory(store, now = Date.now()) {
  const wanted = listStations('inflow').filter((s) => s.travelTimeHours);

  const results = await Promise.all(
    wanted.map(async (station) => {
      const atMs = now - station.travelTimeHours * 3600 * 1000;
      try {
        return [station.id, await store.readingAt(station.id, atMs)];
      } catch {
        // A failed history lookup must not fail the balance; the station simply falls
        // back to its current reading and the response reports a lower laggedCount.
        return [station.id, null];
      }
    }),
  );

  const byStation = new Map(results);
  return (stationId) => byStation.get(stationId) || null;
}

module.exports = { loadLagHistory };
