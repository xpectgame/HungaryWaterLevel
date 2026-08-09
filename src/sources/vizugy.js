'use strict';

const { pollableStations, getStation } = require('../config/stations');
const { fetchJson, browserHeaders } = require('../lib/http');
const { createTokenProvider } = require('./vizugy-auth');

/**
 * Adapter for OVF's hydrological open data.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT, AS CONFIRMED AGAINST THE LIVE SERVICE
 * ---------------------------------------------------------------------------
 * Auth      GET  https://data.vizugy.hu/AuthApi/auth/token
 *           An anonymous 15-minute JWT issued to `opendatauser`. No credentials.
 *           Requires the Origin and Referer a browser sends, or it answers 403.
 *
 * Catalogue GET  {base}/Vra/InternetVmo/11/false   -> InternetVMO[]
 *           1193 surface stations. `Tsz` is the törzsszám every other call takes.
 *           /Vra/Vmo/11/false is the full list, 5035 entries, for stations the
 *           published subset omits - Tiszabecs is one.
 *
 * Series    POST {base}/TS/TsShort    body RequestTS[]  -> TSShortResponse[]
 *           {ItemId, Torzsszam, AdatFajtaKod, AdatTipusKod, StartTime, EndTime}
 *           answers {ItemId, TsItemList:[{UTCTime, Adat, DataExt}]}.
 *
 * AdatFajtaKod 87 is "Felszíni vízhozam" in m3/s. 68 is stage in centimetres -
 * substituting it returns a number several times larger and entirely plausible.
 * AdatTipusKod 100 is `operatív`, the real-time feed; 5 is `előrejelzett`, which
 * would put a forecast into the balance as though it had been measured.
 *
 * TsShort rather than TsShortList: the list form answers with an ItemId whose
 * meaning is undocumented, while TsShort lets the caller assign it. One request
 * either way - every station goes in a single POST.
 *
 * ---------------------------------------------------------------------------
 * THE DATA IS OPEN; THE INTERPRETATION IS NOT AUTOMATIC
 * ---------------------------------------------------------------------------
 * Free to use with attribution to OVF and the regional water directorate. What
 * the numbers mean is a separate question - see the note on Rajka in
 * config/stations.js, where a gauge on the Danube reads a fifth of the Danube.
 */

const DEFAULTS = {
  // The query service, not the portal that embeds it.
  baseUrl: 'https://vmservice.vizugy.hu/vraquery',
  authBaseUrl: 'https://data.vizugy.hu/AuthApi/auth',
  seriesPath: '/TS/TsShort',
  hafCode: 87, // Felszíni vízhozam, m3/s
  stageCode: 68, // Felszíni vízállás, cm - the unit the record and flood levels use
  atCode: 100, // operatív
  // How far back to ask. The feed is hourly, so a day is ample and still cheap;
  // it also carries the poll through an upstream gap without reporting a station
  // as unavailable the moment one sample is late.
  lookbackHours: 24,
  timeoutMs: 20000,
};

/**
 * Mapping from our station ids to the portal's own station identifiers (törzsszám).
 *
 * Filled from the live catalogue - GET /Vra/InternetVmo/11/false, 1193 stations - by
 * `npm run probe -- --vizugy`, which matches on three independent signals: the folded
 * station name, the watercourse name, and the river kilometre. Only entries where all
 * three agreed are listed here. A wrong törzsszám does not fail; it reports a different
 * river under a station's name and leaves the balance looking entirely plausible.
 *
 * Three are approximations rather than exact matches, taken deliberately: leaving them
 * unmapped falls back to the long-term mean, and during the drought these readings were
 * taken in that mean overstates the real flow several times over. Each substitution is
 * within a few kilometres on the correct river, and together they are under 1% of the
 * inflow sum, so the approximation costs far less than the fallback.
 *
 *   fekete-koros-sarkad  Sarkad-Malomfok (2745), the principal gauge. The nearer
 *                        candidates are pumping-station gauges in the six-digit block.
 *   repce-zsira          Répcevis (349), 0.8 km away and the only Répce gauge at the
 *                        border reach; Zsira is the neighbouring village.
 * The Lajta is left unmapped on purpose. Neither of its two gauges publishes a usable
 * discharge series: Hegyeshalom (19) returns nothing at all, and the barrage tailwater
 * at Mosonmagyaróvár (20) returned exactly 0.0 - which on a tailwater gauge means the
 * gate is shut, not that the river stopped. A structure gauge measures the structure.
 *
 * So it falls back to climatology, and that is the better of two wrong answers here: an
 * estimate labelled as an estimate beats a zero that looks like a measurement. At 8 m3/s
 * long-term it is 0.7% of the inflow sum, well inside the error band either way.
 */
const EXTERNAL_IDS = Object.freeze({
  // Danube system
  // Komárom is the inflow section: below the Gabcikovo canal rejoining near Szap and
  // above the Vág. Rajka is 80 km upstream of it and below the Cunovo diversion, so it
  // is published but never summed - see config/stations.js.
  'duna-komarom': '5',
  'duna-rajka': '1',
  'duna-nagymaros': '1020',
  'duna-budapest': '1026',
  'duna-paks': '549',
  'duna-mohacs': '831',
  'raba-szentgotthard': '342',
  'pinka-felsocsatar': '345',
  'repce-zsira': '349', // Répcevis, 0.8 km
  'ipoly-ipolytarnoc': '1040',

  // Tisza system
  // Tiszabecs is absent from /Vra/InternetVmo but present in the full /Vra/Vmo list,
  // which is why the catalogue match reported it missing rather than misspelled.
  'tisza-tiszabecs': '1514',
  'szamos-csenger': '1523',
  'tur-garbolc': '1527',
  'kraszna-agerdomajor': '1530',
  'bodrog-felsoberecki': '1724',
  'sajo-sajopuspoki': '1726',
  'bodva-hidvegardo': '1742',
  'hernad-hidasnemeti': '1732',
  'sebes-koros-korosszakal': '2736',
  'berettyo-pocsaj': '2545',
  'fekete-koros-sarkad': '2745', // Sarkad-Malomfok
  'feher-koros-gyula': '2747',
  'maros-mako': '2278',
  'tisza-szolnok': '2046',
  'tisza-szeged': '2275',
  'tisza-tiszasziget': '2279',

  // Drava system
  // Drávaszabolcs matched on name and river but 9.7 river-km off. It is the only gauge
  // of that name on the Dráva and Őrtilos matched to 0.1 km on the same river, so the
  // registry's figure is the doubtful one, not the match. Accepted; riverKm needs a check.
  'drava-dravaszabolcs': '836',
  'drava-ortilos': '833',
  'mura-letenye': '360',
});

function config(env = process.env) {
  const num = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    baseUrl: env.VIZUGY_BASE_URL || DEFAULTS.baseUrl,
    authBaseUrl: env.VIZUGY_AUTH_BASE_URL || DEFAULTS.authBaseUrl,
    seriesPath: env.VIZUGY_SERIES_PATH || DEFAULTS.seriesPath,
    hafCode: num(env.VIZUGY_HAF_CODE, DEFAULTS.hafCode),
    stageCode: num(env.VIZUGY_STAGE_CODE, DEFAULTS.stageCode),
    atCode: num(env.VIZUGY_AT_CODE, DEFAULTS.atCode),
    lookbackHours: num(env.VIZUGY_LOOKBACK_HOURS, DEFAULTS.lookbackHours),
    timeoutMs: num(env.VIZUGY_TIMEOUT_MS, DEFAULTS.timeoutMs),
    apiKey: env.VIZUGY_API_KEY || null,
  };
}

/** The service address. Concatenated, not resolved - see the note in seriesUrl's test. */
function seriesUrl(cfg) {
  // Say which config arrived rather than throwing "cannot read startsWith of undefined".
  // The probe passed MAVIR's config here by accident, and the TypeError named neither
  // the caller nor the missing field.
  if (!cfg || typeof cfg.seriesPath !== 'string' || typeof cfg.baseUrl !== 'string') {
    throw new TypeError(`seriesUrl needs a vizugy config with baseUrl and seriesPath, got ${JSON.stringify(cfg)}`);
  }

  // `new URL('/TS/TsShort', 'https://h/vraquery')` resolves the leading slash against
  // the origin and silently drops `/vraquery`. The base path is part of the service
  // address here, not a directory to navigate away from.
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const path = cfg.seriesPath.startsWith('/') ? cfg.seriesPath : `/${cfg.seriesPath}`;
  return `${base}${path}`;
}

/** The stations this adapter can actually address, in request order. */
function mappedStations() {
  return pollableStations().filter((station) => EXTERNAL_IDS[station.id]);
}

/**
 * Build the request body: one entry per station, in one POST.
 *
 * ItemId is the index into the station list, which is what makes the response
 * unambiguous - the service echoes it back and nothing else identifies the series.
 */
function buildRequest(stations, cfg, now = new Date()) {
  const endTime = new Date(now.getTime() + 60 * 60 * 1000); // clock skew headroom
  const startTime = new Date(now.getTime() - cfg.lookbackHours * 60 * 60 * 1000);

  const ask = (station, index, code) => ({
    ItemId: index,
    Torzsszam: Number(EXTERNAL_IDS[station.id]),
    AdatFajtaKod: code,
    AdatTipusKod: cfg.atCode,
    StartTime: startTime.toISOString(),
    EndTime: endTime.toISOString(),
  });

  // Discharge and stage in one request. Each entry carries its own AdatFajtaKod, so
  // asking for both costs nothing extra - and stage is what the record lows and the
  // flood grades are expressed in, so without it those thresholds cannot be compared
  // to anything. Stage entries are indexed above the discharge block so one ItemId
  // still identifies exactly one series.
  return [
    ...stations.map((station, index) => ask(station, index, cfg.hafCode)),
    ...stations.map((station, index) => ask(station, stations.length + index, cfg.stageCode)),
  ];
}

/**
 * Newest usable sample from one TSShortResponse.
 *
 * Samples are not assumed to arrive in order, and a null `Adat` is a real occurrence -
 * the series carries a slot for every hour whether or not the gauge reported.
 */
function latestSample(entry) {
  const items = (entry && entry.TsItemList) || [];

  let best = null;
  for (const item of items) {
    const raw = item && item.Adat;
    // Number(null) is 0 and 0 is finite, so a reported gap would enter the balance as
    // a river that has stopped flowing - a physically meaningful and entirely wrong
    // value, and one that no plausibility check downstream would reject.
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const time = new Date(item.UTCTime);
    if (Number.isNaN(time.getTime())) continue;
    if (!best || time > best.time) best = { time, value };
  }

  if (!best) return null;
  return { flowM3s: best.value, timestamp: best.time.toISOString() };
}

let tokenProvider = null;

/** One provider per process, so every station shares a single token. */
function getTokenProvider(cfg) {
  if (!tokenProvider) tokenProvider = createTokenProvider({ authBaseUrl: cfg.authBaseUrl });
  return tokenProvider;
}

/** Reset between tests, and after a 401. */
function resetTokenProvider() {
  tokenProvider = null;
}

async function postSeries(body, cfg) {
  const bearer = cfg.apiKey || (await getTokenProvider(cfg).getToken());
  const origin = new URL(cfg.authBaseUrl).origin;

  return fetchJson(seriesUrl(cfg), {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: cfg.timeoutMs,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      'Content-Type': 'application/json',
      ...browserHeaders(origin),
    },
  });
}

/**
 * Fetch every mapped station in a single request.
 *
 * One failing gauge must not take the balance down, so a station that returns no usable
 * sample is reported as an error against that station rather than thrown. A transport
 * failure does take the whole call down - there is only one request - and that is
 * reported once rather than thirty times.
 */
async function fetchAll(env = process.env) {
  const cfg = config(env);
  const stations = mappedStations();
  const readings = {};
  const errors = [];

  const unmapped = pollableStations().filter((station) => !EXTERNAL_IDS[station.id]);
  for (const station of unmapped) {
    errors.push({ stationId: station.id, error: 'no törzsszám mapped for this station' });
  }

  if (stations.length === 0) {
    return { source: 'vizugy', fetchedAt: new Date().toISOString(), readings, errors, configured: false };
  }

  try {
    const response = await postSeries(buildRequest(stations, cfg), cfg);
    const entries = Array.isArray(response) ? response : [];
    const byItemId = new Map(entries.map((entry) => [Number(entry.ItemId), entry]));

    stations.forEach((station, index) => {
      const sample = latestSample(byItemId.get(index));
      const stage = latestSample(byItemId.get(stations.length + index));

      if (!sample) {
        errors.push({ stationId: station.id, error: 'no discharge sample in the requested window' });
        return;
      }
      readings[station.id] = {
        stationId: station.id,
        flowM3s: sample.flowM3s,
        // Stage is a bonus, not a requirement: a gauge can publish discharge and not
        // stage, and losing the discharge over that would be the wrong trade.
        //
        // Named for the column all three stores already have. Calling it `stageCm` here
        // meant every store dropped it on write, so the value was fetched, parsed and
        // then discarded on the way to the database.
        waterLevelCm: stage ? stage.flowM3s : null,
        timestamp: sample.timestamp,
        source: 'vizugy',
        quality: 'measured',
      };
    });
  } catch (err) {
    // A 401 means the cached token outlived its usefulness; drop it so the next cycle
    // mints a fresh one rather than repeating the same rejected request.
    if (err && err.status === 401) getTokenProvider(cfg).invalidate();
    errors.push({ stationId: null, error: String((err && err.message) || err) });
  }

  return {
    source: 'vizugy',
    fetchedAt: new Date().toISOString(),
    readings,
    errors,
    configured: stations.length > 0,
  };
}

/** One station. Implemented on top of the batch call so there is one code path. */
async function fetchStation(stationId, env = process.env) {
  const station = getStation(stationId);
  if (!station) throw new Error(`Unknown station: ${stationId}`);
  if (!EXTERNAL_IDS[stationId]) return null;

  const cfg = config(env);
  const response = await postSeries(buildRequest([station], cfg), cfg);
  const entries = Array.isArray(response) ? response : [];
  const sample = latestSample(entries.find((entry) => Number(entry.ItemId) === 0) || entries[0]);
  if (!sample) return null;

  return {
    stationId,
    flowM3s: sample.flowM3s,
    timestamp: sample.timestamp,
    source: 'vizugy',
    quality: 'measured',
  };
}

module.exports = {
  fetchStation,
  fetchAll,
  config,
  seriesUrl,
  buildRequest,
  latestSample,
  mappedStations,
  resetTokenProvider,
  EXTERNAL_IDS,
  DEFAULTS,
};
