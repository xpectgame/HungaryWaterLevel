'use strict';

const { listWells, WELL_KIND } = require('../config/wells');
const { listShallowWells, SHALLOW_KIND } = require('../config/shallow-wells');
const { fetchJson, browserHeaders } = require('../lib/http');
const { createTokenProvider } = require('./vizugy-auth');
const { config: vizugyConfig, seriesUrl, indexByItemId } = require('./vizugy');

/**
 * Groundwater levels, read outside the fifteen-minute poll.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN THE POLL
 * ---------------------------------------------------------------------------
 * The poll runs every fifteen minutes because a river can rise in an hour. Groundwater
 * cannot. These wells report a handful of times a day at best and much of the network is
 * an observer with a dip meter on a fortnightly round, so polling 106 wells ninety-six
 * times a day would ask someone else's public service for the same number four hundred
 * times over. It is read on demand behind a long cache instead, like rainfall.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WINDOW IS DAYS WIDE FOR A SINGLE CURRENT VALUE
 * ---------------------------------------------------------------------------
 * Asking for "now" would return nothing from most of this network, because most of it was
 * last read days ago. The window is wide enough to catch the slowest observer round, and
 * the ANSWER carries the age of what it found - a level from three weeks ago is a fine
 * groundwater reading and a terrible one to present as today's without saying so.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not convert, scale, sign-correct or compare anything. The values come back in
 * whatever unit and sign convention each well uses - the network mixes metres and
 * centimetres, and for some wells the live feed disagrees with that well's own archive.
 * Every one of those judgements belongs downstream where the well's own ten-year record
 * is available to make them against. A source module that "helpfully" normalised here
 * would be guessing, and the guess would be invisible by the time it was wrong.
 */

/** Wide enough for the slowest observer round in the network. */
const DEFAULT_DAYS = 40;

/**
 * One POST for the whole network.
 *
 * 106 series in a request, against the 524-series batches the scan ran without complaint.
 */
function buildWellRequest(wells, cfg, { days = DEFAULT_DAYS, now = new Date(), kind = WELL_KIND } = {}) {
  const endTime = new Date(now.getTime() + 60 * 60 * 1000);
  const startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return wells.map((well, index) => ({
    ItemId: index,
    Torzsszam: Number(well.tsz),
    // Not cfg.atCode. The rest of this project reads AdatTipusKod 100, operatív, and
    // groundwater is not served under it - asking 100 here returns an empty series at
    // almost every well, which is exactly the false negative that had this project
    // recording "groundwater is not published" for weeks.
    AdatFajtaKod: kind.adatFajtaKod,
    AdatTipusKod: kind.adatTipusKod,
    StartTime: startTime.toISOString(),
    EndTime: endTime.toISOString(),
  }));
}

/** The most recent usable sample in a series, with when it was taken. */
function latestSample(entry) {
  const items = ((entry && entry.TsItemList) || [])
    .filter((item) => item && item.Adat !== null && item.Adat !== undefined && item.Adat !== '')
    .map((item) => ({ at: new Date(item.UTCTime), value: Number(item.Adat) }))
    .filter((item) => !Number.isNaN(item.at.getTime()) && Number.isFinite(item.value))
    .sort((a, b) => a.at - b.at);

  if (!items.length) return null;
  const last = items[items.length - 1];
  return {
    value: last.value,
    at: last.at.toISOString(),
    samples: items.length,
    firstAt: items[0].at.toISOString(),
    // The oldest value in the window, not only when it was taken. With a window a week
    // wide this is what makes "and a week ago it was" possible without keeping a series
    // or a store - and the caller has firstAt beside it, so it can say how long ago
    // "ago" actually was rather than assuming the window was full.
    firstValue: items[0].value,
  };
}

/**
 * The shallow water table, from the other network.
 *
 * Same request shape, different (network, kind, type) triple - and a much shorter window,
 * because these stations report several times a day rather than on a fortnightly round.
 * Asking 40 days of a telemetered network would return forty times more than is needed to
 * answer "where is it now".
 */
async function fetchShallowWells({ days = 10, now = new Date(), env = process.env } = {}) {
  return fetchNetwork(listShallowWells(), SHALLOW_KIND, { days, now, env });
}

async function fetchWells({ days = DEFAULT_DAYS, now = new Date(), env = process.env } = {}) {
  return fetchNetwork(listWells(), WELL_KIND, { days, now, env });
}

/**
 * Soil moisture, from the meteorological network.
 *
 * The same request shape a third time, which is the point of fetchNetwork: this is not a
 * well and it is not a water level, it is a percentage from a probe in the ground - but
 * "ask this (network, kind, type) triple for the latest sample per station" is exactly
 * the same operation, and giving it its own copy of the request builder would be three
 * places to fix the next time the portal changes its mind about a header.
 *
 * Eight days, not forty and not three. Three was enough to answer "what is it now" and
 * nothing else; eight also carries the far end of a week, which is what turns a
 * percentage into a direction. Soil moisture falls visibly over a dry week and jumps
 * within hours of rain, so the week is the window where the number says something.
 */
async function fetchSoilMoisture({ days = 8, now = new Date(), env = process.env } = {}) {
  const registry = require('../config/soil-stations.json');
  return fetchNetwork(registry.stations, registry.kind, { days, now, env });
}

/**
 * Fetch the current level for every station in a network.
 *
 * A station that returns nothing is recorded as an error against it rather than dropped,
 * for the same reason the rain gauges are: a network that quietly shrinks looks identical
 * to a network whose readings all moved, and only one of those is news.
 */
async function fetchNetwork(wells, kind, { days, now, env }) {
  const cfg = vizugyConfig(env);
  const byWell = {};
  const errors = [];

  const body = buildWellRequest(wells, cfg, { days, now, kind });
  const bearer = cfg.apiKey || (await createTokenProvider({ authBaseUrl: cfg.authBaseUrl }).getToken());

  const response = await fetchJson(seriesUrl(cfg), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: Math.max(cfg.timeoutMs, 45000),
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      'Content-Type': 'application/json',
      ...browserHeaders(new URL(cfg.authBaseUrl).origin),
    },
  });

  const byItemId = indexByItemId(Array.isArray(response) ? response : []);

  wells.forEach((well, index) => {
    const sample = latestSample(byItemId.get(index));
    if (!sample) {
      // Named for the kind rather than hard-coded to "groundwater": this function
      // serves three networks now, and a soil-moisture station reporting nothing should
      // not file itself under a word that has never applied to it.
      errors.push({ wellId: well.id, error: `no ${kind.label} samples in the requested window` });
      return;
    }
    byWell[well.id] = sample;
  });

  return {
    source: 'vizugy',
    kind: kind.label,
    fetchedAt: new Date().toISOString(),
    windowDays: days,
    wells: byWell,
    errors,
  };
}

module.exports = {
  fetchWells, fetchShallowWells, fetchSoilMoisture, buildWellRequest, latestSample, DEFAULT_DAYS,
};
