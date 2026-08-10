'use strict';

const { listRainGauges } = require('../config/rain-gauges');
const { fetchJson, browserHeaders } = require('../lib/http');
const { createTokenProvider } = require('./vizugy-auth');
const { config: vizugyConfig, seriesUrl, indexByItemId } = require('./vizugy');

/**
 * Rainfall, read straight through from the archive rather than accumulated locally.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE DOES NOT GO THROUGH THE STORE
 * ---------------------------------------------------------------------------
 * Every other reading here is an instantaneous value, so the store's job is to remember
 * what "now" was at each past moment. Rainfall is already an accumulation, and the
 * question asked of it - how much fell over the last thirty days - needs thirty days of
 * history to answer at all.
 *
 * Storing it would mean the answer is wrong for the first month after any deployment,
 * and wrong again after any gap in polling, in a way that is invisible: a missing week
 * looks exactly like a dry week. The upstream already holds a ten-year archive and will
 * return the whole window in one request, so this reads it through and caches the
 * result. The upstream is the record; duplicating it would only introduce ways to
 * disagree with it.
 *
 * ---------------------------------------------------------------------------
 * SUMS, NOT LEVELS
 * ---------------------------------------------------------------------------
 * Each sample is the rain that fell since the previous sample, so a period total is the
 * sum of the samples in it. The reporting interval is not constant across the network -
 * most gauges report once a day around 04:00-06:00 UTC, a few twice, and the telemetered
 * ones every fifteen minutes - and summing increments is correct for all of them. Taking
 * the last value, or averaging, is correct for none.
 */

const RAIN_CODE = 71; // Csapadékösszeg, mm
const DEFAULT_DAYS = 30;

/** One POST for the whole network: 47 gauges is well inside what the service accepts. */
function buildRainRequest(gauges, cfg, { days = DEFAULT_DAYS, now = new Date() } = {}) {
  const endTime = new Date(now.getTime() + 60 * 60 * 1000);
  const startTime = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return gauges.map((gauge, index) => ({
    ItemId: index,
    Torzsszam: Number(gauge.tsz),
    AdatFajtaKod: RAIN_CODE,
    AdatTipusKod: cfg.atCode,
    StartTime: startTime.toISOString(),
    EndTime: endTime.toISOString(),
  }));
}

/**
 * Total the increments, and report the shape of what was totalled.
 *
 * `days` and `lastAt` are carried out because a total is uninterpretable without them:
 * 3 mm over thirty days is a drought, and 3 mm from a gauge whose last sample is three
 * weeks old is a broken gauge. The caller has to be able to tell those apart.
 */
function summarise(entry) {
  const items = ((entry && entry.TsItemList) || [])
    .filter((item) => item && item.Adat !== null && item.Adat !== undefined && item.Adat !== '')
    .map((item) => ({ at: new Date(item.UTCTime), mm: Number(item.Adat) }))
    .filter((item) => !Number.isNaN(item.at.getTime()) && Number.isFinite(item.mm))
    .sort((a, b) => a.at - b.at);

  if (items.length === 0) return null;

  // A negative increment is a correction or a sensor fault; neither is rain, and letting
  // one through would subtract from a total that is supposed to be monotonic.
  const usable = items.filter((item) => item.mm >= 0);
  if (usable.length === 0) return null;

  const totalMm = usable.reduce((sum, item) => sum + item.mm, 0);
  const wetDays = new Set(usable.filter((item) => item.mm > 0).map((item) => item.at.toISOString().slice(0, 10)));

  // The most recent day with any rain at all - "when did it last rain here" is the
  // question people actually ask, and it is not the same as the last sample.
  const lastWet = [...usable].reverse().find((item) => item.mm > 0) || null;

  return {
    totalMm: Math.round(totalMm * 10) / 10,
    samples: usable.length,
    wetDays: wetDays.size,
    firstAt: usable[0].at.toISOString(),
    lastAt: usable[usable.length - 1].at.toISOString(),
    lastRainAt: lastWet ? lastWet.at.toISOString() : null,
  };
}

/** Daily totals across the window, for a chart. Keyed by UTC date. */
function dailyTotals(entry) {
  const byDay = new Map();
  for (const item of (entry && entry.TsItemList) || []) {
    if (!item || item.Adat === null || item.Adat === undefined || item.Adat === '') continue;
    const mm = Number(item.Adat);
    const at = new Date(item.UTCTime);
    if (!Number.isFinite(mm) || mm < 0 || Number.isNaN(at.getTime())) continue;
    const day = at.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + mm);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, mm]) => ({ date, mm: Math.round(mm * 10) / 10 }));
}

/**
 * Fetch the window for every registered gauge.
 *
 * A gauge that returns nothing is reported as an error against that gauge rather than
 * silently omitted, because "no rain recorded" and "gauge not reporting" are the two
 * readings this whole feature exists to keep apart.
 */
async function fetchRainfall({ days = DEFAULT_DAYS, now = new Date(), env = process.env } = {}) {
  const cfg = vizugyConfig(env);
  const gauges = listRainGauges();
  const byGauge = {};
  const errors = [];

  const body = buildRainRequest(gauges, cfg, { days, now });
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

  gauges.forEach((gauge, index) => {
    const entry = byItemId.get(index);
    const summary = summarise(entry);
    if (!summary) {
      errors.push({ gaugeId: gauge.id, error: 'no rainfall samples in the requested window' });
      return;
    }
    byGauge[gauge.id] = { ...summary, daily: dailyTotals(entry) };
  });

  return {
    source: 'vizugy',
    fetchedAt: new Date().toISOString(),
    windowDays: days,
    from: new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString(),
    to: now.toISOString(),
    gauges: byGauge,
    errors,
  };
}

module.exports = {
  fetchRainfall,
  buildRainRequest,
  summarise,
  dailyTotals,
  RAIN_CODE,
  DEFAULT_DAYS,
};
