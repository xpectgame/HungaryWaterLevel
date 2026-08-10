'use strict';

const { fetchText, fetchJson, browserHeaders } = require('../lib/http');
const { describeShape } = require('../lib/jsonpath');
const { summarizeOperations, describeSchema } = require('../lib/openapi');
const vizugy = require('../sources/vizugy');
const mavir = require('../sources/mavir');
const { createTokenProvider } = require('../sources/vizugy-auth');
const { discover } = require('./discover');
const { matchStations, report } = require('./catalogue');
const { fetchDocs } = require('./docs');

/**
 * Endpoint discovery tool.
 *
 * The two upstream services could not be reached from the environment this project was
 * written in, so their exact paths and response shapes are configuration rather than
 * hard-coded assumptions. This script is how you close that gap: run it from a machine
 * that can reach them, read what it prints, and set the matching environment variables.
 *
 *   node src/jobs/probe.js                 discover both, then probe what turns up
 *   node src/jobs/probe.js --mavir         one service only
 *   node src/jobs/probe.js --url=https://data.vizugy.hu/some/path
 *   node src/jobs/probe.js --page=https://example.hu/  mine one page's bundles
 *
 * Both portals are single-page applications: the HTML carries no data and no endpoint,
 * so there is nothing to guess from. What the bundles do carry is the URL they fetch
 * from, as a plain string literal - so discovery downloads them and reads it out.
 *
 * It prints the response shape as dotted paths, which map directly onto the
 * VIZUGY_ARRAY_PATH / VIZUGY_VALUE_FIELD / MAVIR_ARRAY_PATH settings.
 */

async function probeUrl(url, label, opts = {}) {
  // How much of a non-JSON body to show. 400 characters is enough to recognise an error
  // page, and far too little to read a configuration out of one - the swagger shell hid
  // its OpenAPI document just past that cut.
  const { maxChars = 400, ...fetchOpts } = opts;

  console.log(`\n=== ${label || url} ===`);
  console.log(`GET ${url}`);

  try {
    const { body, contentType } = await fetchText(url, { timeoutMs: 20000, retries: 0, ...fetchOpts });
    console.log(`content-type: ${contentType}`);
    console.log(`length: ${body.length} bytes`);

    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      console.log(`Not JSON. First ${maxChars} characters:\n`);
      console.log(trimmed.slice(0, maxChars));
      if (trimmed.length > maxChars) console.log(`\n... (${trimmed.length - maxChars} more bytes)`);
      console.log('\nIf this is HTML, the data is probably behind a different path or loaded by a script.');
      return null;
    }

    const payload = JSON.parse(trimmed);
    console.log('\nResponse shape (dotted paths -> sample values):');
    for (const line of describeShape(payload).slice(0, 60)) {
      console.log(`  ${line}`);
    }

    console.log('\nSet the array path to whichever path above ends in [] and holds the samples.');
    return payload;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    if (err.status === 403 || err.status === 401) {
      console.log('A 403/401 usually means an API key or a Referer header is required.');
    }
    return null;
  }
}

const VRAQUERY_BASE = 'https://vmservice.vizugy.hu/vraquery';
const OPENAPI_URL = `${VRAQUERY_BASE}/swagger/v1.0/swagger.json`;

/**
 * Read the contract instead of guessing at it.
 *
 * The document was found by the swagger UI's own initialiser naming it. It is ~90 KB,
 * so it is flattened to one line per operation; the two schemas that matter are then
 * expanded in full, because the time-series call is a POST and its body is the only
 * part of this API that cannot be worked out by trying URLs.
 */
async function probeOpenApi() {
  console.log('\n########## vraquery contract ##########');
  console.log(`GET ${OPENAPI_URL}`);

  let spec;
  try {
    spec = await fetchJson(OPENAPI_URL, {
      timeoutMs: 30000,
      headers: browserHeaders('https://vmservice.vizugy.hu', `${VRAQUERY_BASE}/swagger/index.html`),
    });
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return null;
  }

  const info = spec.info || {};
  console.log(`${info.title || 'untitled'} ${info.version || ''} - ${info.description || ''}`);
  console.log(`servers: ${JSON.stringify(spec.servers || [])}`);

  const operations = summarizeOperations(spec);
  console.log(`\n${operations.length} line(s) of operations:\n`);
  for (const line of operations) console.log(`  ${line}`);

  // The names the document actually uses. POST /TS/TsShortList takes a RequestTSList
  // and answers TSShortResponse[]; the catalogue answers InternetVMO[]. Those four
  // types are the whole contract this project needs.
  console.log('\nSchemas for the calls this project makes:');
  for (const name of ['RequestTSList', 'RequestTS', 'TSFilter', 'TSShortResponse', 'TSShortItemDT', 'InternetVMO']) {
    for (const line of describeSchema(spec, name, { depth: 4 })) console.log(`  ${line}`);
    console.log('');
  }

  return spec;
}

/**
 * The hydrological data-type list.
 *
 * Every time-series call is parameterised by an `adatfajta` code - water level,
 * discharge, precipitation - and discharge in m3/s is the only one this project wants.
 * The portal's bundle carries a partial table (74 = spring discharge in l/s, 92 =
 * spring stage, 69 = groundwater), but not the surface figures, and picking the wrong
 * code returns a plausible number in the wrong unit. The service publishes the list.
 */
/** The raw catalogue. `internetOnly` picks the published subset over the full list. */
async function fetchCatalogue(vmoType = 11, { internetOnly = true } = {}) {
  const url = `${VRAQUERY_BASE}/Vra/${internetOnly ? 'InternetVmo' : 'Vmo'}/${vmoType}/false`;
  const token = await createTokenProvider().getToken();
  const rows = await fetchJson(url, {
    timeoutMs: 30000,
    headers: { Authorization: `Bearer ${token}`, ...browserHeaders('https://data.vizugy.hu') },
  });
  return { url, rows };
}

/**
 * Search the catalogue by name or watercourse.
 *
 * Tiszabecs - the Tisza's entry gauge, and the second largest inflow in the country -
 * came back as MISSING with nothing on the Tisza within 17 km of it. That is either a
 * different spelling or a genuine absence from the internet-published subset, and the
 * difference matters: one is a lookup, the other means falling back to /Vra/Vmo. Both
 * lists are searched so the answer is visible rather than inferred.
 */
async function probeFind(needle) {
  console.log(`\n########## catalogue search: ${needle} ##########`);
  const wanted = needle.toLowerCase();

  for (const internetOnly of [true, false]) {
    try {
      const { url, rows } = await fetchCatalogue(11, { internetOnly });
      const hits = rows.filter((row) =>
        [row.Nev, row.MdrNev, row.Telepules, row.Tsz].some((field) =>
          String(field ?? '').toLowerCase().includes(wanted),
        ),
      );
      console.log(`\n${url}\n${rows.length} stations, ${hits.length} matching:`);
      for (const hit of hits.slice(0, 40)) console.log(`  ${JSON.stringify(hit)}`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
}

/**
 * Fetch the station catalogue and line it up against the registry.
 *
 * This is what produces EXTERNAL_IDS. A wrong identifier here does not fail - it
 * reports a different river under a station's name and the balance stays plausible,
 * so the matcher checks the coordinates and the river kilometre as well as the name,
 * and labels how much the three agree.
 */
async function probeCatalogue(vmoType = 11) {
  console.log(`\n########## station catalogue (vmoType ${vmoType}) ##########`);

  try {
    const { url, rows } = await fetchCatalogue(vmoType);
    console.log(`GET ${url}`);

    if (!Array.isArray(rows)) {
      console.log(`Expected an array, got ${typeof rows}: ${JSON.stringify(rows).slice(0, 300)}`);
      return null;
    }

    console.log(`${rows.length} stations in the catalogue.`);
    console.log(`\nOne record, in full:\n${JSON.stringify(rows[0], null, 2)}`);

    console.log('\nMatched against the registry:\n');
    for (const line of report(matchStations(rows))) console.log(line);

    return rows;
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return null;
  }
}

// Confirmed from /Base/AdatFajta: "Felszíni vízhozam", m3/s. Stage is 68 and reads in
// centimetres, which is the mistake this constant exists to prevent - it would return a
// number four times too large and perfectly plausible.
const HAF_SURFACE_DISCHARGE = 87;

/**
 * Find which data-type code actually carries live discharge.
 *
 * /Base/AdatTipus lists 21 of them and the difference is not cosmetic: `operatív` is
 * the real-time feed, `feldolgozott` is quality-controlled and lags by weeks, and
 * `előrejelzett` is a forecast that would enter the balance as though it were a
 * measurement. There is no way to tell from the list which one is populated right now,
 * so ask for the same day at one station under each candidate and see what comes back.
 */
async function probeSeries(torzsszam = 1, label = 'Rajka') {
  console.log(`\n########## time series: ${label} (Tsz ${torzsszam}), haf ${HAF_SURFACE_DISCHARGE} ##########`);

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 48 * 3600 * 1000);

  // TsShort rather than TsShortList: the list form takes a bare array of törzsszám and
  // answers with an ItemId whose meaning is not documented, while TsShort lets the
  // caller assign the ItemId and get it back. Same single request, unambiguous mapping.
  const candidates = [
    { code: 100, name: 'operatív' },
    { code: 101, name: 'operatív összefésült' },
    { code: 6, name: 'számított' },
    { code: 2, name: 'regisztrált' },
    { code: 9, name: 'hidrológiai idősor' },
    { code: 1, name: 'nyers észlelt' },
  ];

  for (const { code, name } of candidates) {
    const body = [
      {
        ItemId: 1,
        Torzsszam: torzsszam,
        AdatFajtaKod: HAF_SURFACE_DISCHARGE,
        AdatTipusKod: code,
        StartTime: startTime.toISOString(),
        EndTime: endTime.toISOString(),
      },
    ];

    try {
      const token = await createTokenProvider().getToken();
      const response = await fetchJson(`${VRAQUERY_BASE}/TS/TsShort`, {
        timeoutMs: 25000,
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...browserHeaders('https://data.vizugy.hu'),
        },
      });

      const items = (Array.isArray(response) ? response : []).flatMap((r) => r.TsItemList || []);
      if (items.length === 0) {
        console.log(`  AdatTipusKod ${String(code).padEnd(4)} ${name.padEnd(22)} - empty`);
        continue;
      }
      const last = items[items.length - 1];
      console.log(
        `  AdatTipusKod ${String(code).padEnd(4)} ${name.padEnd(22)} - ${items.length} samples,` +
          ` latest ${last.UTCTime} = ${last.Adat} m3/s`,
      );
    } catch (err) {
      console.log(`  AdatTipusKod ${String(code).padEnd(4)} ${name.padEnd(22)} - FAILED: ${err.message.split('\n')[0]}`);
    }
  }

  console.log('\nThe code with recent samples in a plausible range is the one to configure.');
}

/**
 * Every mapped station's current discharge, next to its long-term mean.
 *
 * This is the adapter's own path, so it doubles as an end-to-end check. The ratio
 * column is the point: a gauge reading a fifth of its mean is either a drought or the
 * wrong section of river, and the two are distinguishable by whether the neighbours
 * agree. Rajka came back at 411 m3/s against a mean of 2020 while sitting below the
 * Cunovo diversion - if Nagymaros and Budapest read near their own means at the same
 * moment, that settles which of the two explanations holds.
 */
async function probeAllStations() {
  console.log('\n########## live discharge, all mapped stations ##########');

  const { getStation } = require('../config/stations');
  const result = await vizugy.fetchAll();

  const rows = Object.values(result.readings)
    .map((reading) => {
      const station = getStation(reading.stationId);
      return {
        station,
        reading,
        ratio: station.meanFlow ? reading.flowM3s / station.meanFlow : null,
      };
    })
    .sort((a, b) => b.reading.flowM3s - a.reading.flowM3s);

  console.log(`${rows.length} stations returned a sample, ${result.errors.length} did not.\n`);
  console.log(`  ${'station'.padEnd(28)} ${'role'.padEnd(9)} ${'m3/s'.padStart(9)} ${'mean'.padStart(7)}  ratio  latest`);

  for (const { station, reading, ratio } of rows) {
    const flag = ratio !== null && (ratio < 0.35 || ratio > 3) ? '  <-- far from its mean' : '';
    console.log(
      `  ${station.id.padEnd(28)} ${String(station.role).padEnd(9)} ${reading.flowM3s.toFixed(1).padStart(9)}` +
        ` ${String(station.meanFlow ?? '-').padStart(7)}  ${ratio === null ? '   -' : ratio.toFixed(2)}` +
        `  ${reading.timestamp}${flag}`,
    );
  }

  for (const error of result.errors) {
    console.log(`  ${String(error.stationId ?? '(whole request)').padEnd(28)} ${error.error}`);
  }

  // Summed the way the balance sums them, so the arithmetic is visible rather than
  // buried behind an endpoint.
  const sum = (role) =>
    rows.filter((r) => r.station.role === role).reduce((total, r) => total + r.reading.flowM3s, 0);
  const inflow = sum('inflow');
  const outflow = sum('outflow');

  console.log(`\n  sum inflow  ${inflow.toFixed(0)} m3/s`);
  console.log(`  sum outflow ${outflow.toFixed(0)} m3/s`);
  console.log(`  difference  ${(inflow - outflow).toFixed(0)} m3/s`);
  console.log(
    '\nOutflow much larger than inflow means water is entering through a section that is ' +
      'not being counted.',
  );
}

/**
 * Exercise the ENTSO-E documents this project can use in place of MAVIR.
 *
 * A75 answers the same question MAVIR's chart does, from a documented API. A73 answers
 * one MAVIR never does - output per generation unit - which turns the units cooling
 * model from an inference into a measurement.
 */
async function probeEntsoe() {
  const entsoe = require('../sources/entsoe');
  const cfg = entsoe.config();

  console.log('\n########## entsoe ##########');
  if (!cfg.token) {
    console.log('ENTSOE_TOKEN is not set, so nothing can be requested.');
    console.log('Register on https://transparency.entsoe.eu, then email transparency@entsoe.eu');
    console.log('asking for API access. Set ENTSOE_TOKEN and run this again.');
    return;
  }
  console.log(`domain ${cfg.domain}, token ${cfg.token.slice(0, 4)}...`);

  try {
    const generation = await entsoe.fetchGeneration();
    console.log(`\nA75 generation by type at ${generation.timestamp}:`);
    for (const [source, mw] of Object.entries(generation.generationMw).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source.padEnd(14)} ${mw.toFixed(0).padStart(7)} MW`);
    }
    console.log('\nNuclear is Paks I and nothing else - that is the cooling-water driver.');
  } catch (err) {
    console.log(`A75 FAILED: ${err.message}`);
  }

  try {
    const perUnit = await entsoe.fetchUnitGeneration();
    console.log(`\nA73 generation per unit, ${perUnit.units.length} unit(s):`);
    for (const unit of perUnit.units.sort((a, b) => b.powerMw - a.powerMw)) {
      console.log(
        `  ${unit.unitName.padEnd(28)} ${String(unit.sourceType || '?').padEnd(12)}` +
          ` ${unit.powerMw.toFixed(0).padStart(6)} MW  of ${String(unit.nominalMw ?? '?').padStart(5)}  ${unit.timestamp}`,
      );
    }
    console.log('\nPaks units listed separately is what the units cooling model needs.');
  } catch (err) {
    console.log(`A73 FAILED: ${err.message}`);
  }

  try {
    const availability = await entsoe.fetchAvailability();
    console.log(`\nA80 outages: ${availability.activeOutages} active of ${availability.outageCount} published`);
    console.log(JSON.stringify(availability.availability, null, 2));
  } catch (err) {
    console.log(`A80 FAILED: ${err.message}`);
  }
}

/**
 * MAVIR's chart routes, read out of the servlet's own jsRoutes block.
 *
 * The servlet embeds Play's generated route table inline, which settles two things
 * mining never could:
 *
 *   GET /chart/{id}/image/actual        the chart is a server-rendered IMAGE
 *   GET /chart/{id}/export?exportType=…&fromTime=…&toTime=…
 *   GET /reload_needed/{lastReloadTime}
 *
 * There is no JSON time series behind the chart, which is why every search for one
 * failed - the picture is the product. The export route is the only numeric way out.
 *
 * Two things still have to be found by asking: which base the routes hang off (the
 * jsRoutes urls start at "/" while the app is served from /rtdwweb/webuser/), and what
 * exportType accepts. Neither appears in the page, so both are probed.
 */
const MAVIR_CHARTS = {
  4401: 'Erőművi termelés',
  4423: 'Import-Export',
  7678: 'Terv és tény rendszerterhelés',
  10260: 'Rendszer adatok',
};

async function probeMavirExport() {
  console.log('\n########## mavir chart routes ##########');

  const headers = browserHeaders(
    'https://rtdwweb.mavir.hu',
    'https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab4402',
  );

  // jsRoutes builds "/chart/..." but the app is mounted under /rtdwweb/webuser/, and
  // absoluteURL() concatenates the host with that leading slash. One of the two is real.
  const bases = ['https://rtdwweb.mavir.hu', 'https://rtdwweb.mavir.hu/rtdwweb/webuser'];

  console.log('\n--- which base serves the routes ---');
  let liveBase = null;
  for (const base of bases) {
    const url = `${base}/reload_needed/${Date.now() - 900000}`;
    try {
      const { body, contentType } = await fetchText(url, { timeoutMs: 15000, retries: 0, headers });
      console.log(`  OK    ${url}\n        ${contentType} :: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
      if (!liveBase) liveBase = base;
    } catch (err) {
      console.log(`  FAIL  ${url}  (${err.message.split('\n')[0]})`);
    }
  }

  if (!liveBase) {
    console.log('\nNeither base answered; the routes may sit behind the servlet path only.');
    return;
  }

  // Timestamps: the page carries data-reload-time as epoch milliseconds, so that is the
  // unit the routes are most likely to want.
  const to = Date.now();
  const from = to - 6 * 3600 * 1000;

  // Play binds every declared query parameter, so omitting one is a 400 rather than a
  // default. getExportFile takes six; the first attempt sent three and got 400 from
  // every exportType, which reads as "wrong format" and was "wrong arity".
  console.log(`\n--- export, chart 4401 (${MAVIR_CHARTS[4401]}) ---`);
  const combos = [];
  for (const exportType of ['csv', 'xlsx', 'excel', 'CSV', 'XLSX']) {
    for (const periodType of ['custom', 'day', 'hour', 'interval']) {
      combos.push({ exportType, periodType, period: '1' });
    }
  }

  for (const { exportType, periodType, period } of combos) {
    const url =
      `${liveBase}/chart/4401/export?exportType=${exportType}&fromTime=${from}&toTime=${to}` +
      `&periodType=${periodType}&period=${period}`;
    try {
      const { body, contentType } = await fetchText(url, { timeoutMs: 25000, retries: 0, headers });
      const preview = body.slice(0, 400).replace(/\s+/g, ' ');
      console.log(`  OK   ${exportType}/${periodType}  ${body.length} bytes  ${contentType}`);
      console.log(`       ${preview}`);
    } catch (err) {
      // Only the status matters here; the full URL repeated twenty times is noise.
      console.log(`  ---  ${exportType}/${periodType}  ${err.status || err.message.split('\n')[0]}`);
    }
  }

  // The image confirms the route base even when export rejects every type, and its
  // content-type says plainly that the chart is a picture rather than a series.
  // The app always passes lastTimestamp; without it the route 400s just like the export.
  const imageUrl = `${liveBase}/chart/4401/image/actual?lastTimestamp=${to}`;
  try {
    const { body, contentType } = await fetchText(imageUrl, { timeoutMs: 20000, retries: 0, headers });
    console.log(`\n  image  ${body.length} bytes  ${contentType}  <- the chart is rendered server-side`);
  } catch (err) {
    console.log(`\n  image  FAILED: ${err.message.split('\n')[0]}`);
  }
}

/**
 * Ask the deployed site what it is actually serving.
 *
 * Setting DATA_PROVIDER=live is a claim, not a result: the variable may not have been
 * picked up yet, the poller may never have run, or the upstream may refuse the
 * deployment's IP the way it refuses this sandbox's. Every one of those looks identical
 * from the outside - a page with numbers on it - which is exactly the failure this
 * project keeps guarding against. So read the response's own account of itself.
 */
async function probeSite(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  console.log(`\n########## deployed site: ${base} ##########`);

  let snapshot;
  try {
    snapshot = await fetchJson(`${base}/api/v1/snapshot`, { timeoutMs: 30000, retries: 1 });
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return;
  }

  const meta = snapshot._meta || {};
  const balance = snapshot.balance || {};
  const inflow = balance.inflow || {};
  const outflow = balance.outflow || {};

  console.log(`\n  provider      ${meta.provider}`);
  console.log(`  synthetic     ${meta.synthetic}${meta.synthetic ? '   <-- NOT live data' : ''}`);
  console.log(`  last poll     ${meta.lastPollAt || '(never)'}  ok=${meta.lastPollOk}`);

  if (meta.lastPollAt) {
    const ageMin = Math.round((Date.now() - Date.parse(meta.lastPollAt)) / 60000);
    console.log(`  poll age      ${ageMin} min${ageMin > 60 ? '   <-- stale; the cron may not be running' : ''}`);
  }

  console.log(`\n  inflow        ${inflow.totalM3s} m3/s over ${inflow.stationCount} stations` +
    `  (measured ${inflow.measuredCount}, estimated ${inflow.estimatedCount})`);
  console.log(`  outflow       ${outflow.totalM3s} m3/s over ${outflow.stationCount} stations` +
    `  (measured ${outflow.measuredCount}, estimated ${outflow.estimatedCount})`);
  console.log(`  net           ${balance.net && balance.net.m3s} m3/s, significant=${balance.net && balance.net.significant}`);

  for (const warning of (balance.dataQuality && balance.dataQuality.warnings) || []) {
    console.log(`  warning       ${warning}`);
  }

  // The registry's long-term means are the yardstick: every gauge sitting exactly on its
  // mean is the signature of fixture data, not of a river.
  console.log('\n  largest stations, against their long-term mean:');
  const { getStation } = require('../config/stations');
  const rows = [...(inflow.stations || []), ...(outflow.stations || [])]
    .sort((a, b) => b.flowM3s - a.flowM3s)
    .slice(0, 8);

  for (const row of rows) {
    const mean = (getStation(row.id) || {}).meanFlow;
    const ratio = mean ? (row.flowM3s / mean) : null;
    console.log(
      `    ${row.id.padEnd(26)} ${String(row.flowM3s).padStart(9)} m3/s` +
        `  mean ${String(mean ?? '-').padStart(6)}` +
        `  ${ratio === null ? '' : `ratio ${ratio.toFixed(2)}`}  ${row.quality}`,
    );
  }

  const ratios = rows
    .map((row) => {
      const mean = (getStation(row.id) || {}).meanFlow;
      return mean ? row.flowM3s / mean : null;
    })
    .filter((r) => r !== null);

  if (ratios.length > 0) {
    const spread = Math.max(...ratios) - Math.min(...ratios);
    console.log(
      `\n  ratio spread  ${spread.toFixed(2)}` +
        (spread < 0.02
          ? '   <-- every gauge on its mean: that is generated, not measured'
          : '   (gauges differ from each other, as real rivers do)'),
    );
  }
}

/**
 * Download the generation export once and print the grid.
 *
 * The column names are the whole remaining question: they have to be matched against
 * the plant registry, and guessing at them is how one plant's output gets attributed to
 * another. One request, because twenty took the host to 429 and kept it there.
 */
async function probeMavirSheet() {
  console.log('\n########## mavir generation export ##########');
  try {
    const { url, rows } = await mavir.fetchSheet();
    console.log(`GET ${url}\n${rows.length} rows\n`);

    for (const [i, row] of rows.slice(0, 14).entries()) {
      const cells = row.map((c) => (c === null ? '' : typeof c === 'number' ? c.toFixed(1) : String(c)));
      console.log(`  ${String(i).padStart(3)}  ${cells.join(' | ')}`);
    }
    if (rows.length > 14) console.log(`  ... ${rows.length - 14} more rows`);

    const parsed = mavir.parseSheet(rows);
    console.log(`\n  newest row: ${parsed.timestamp}`);
    console.log('  plant columns and their current output:');
    for (const [name, mw] of Object.entries(parsed.byPlant).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${name.padEnd(34)} ${mw.toFixed(1).padStart(9)} MW`);
    }

    console.log('\n  Registry plants awaiting a column match:');
    for (const plant of require('../config/powerplants').listPlants('operating')) {
      console.log(`    ${plant.id.padEnd(20)} ${plant.name}`);
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    console.log('A 429 means the host is rate limited - wait, do not retry in a loop.');
  }
}

/**
 * The record and flood levels the catalogue already carries, for our stations only.
 *
 * LKV and LNV are the lowest and highest stage ever measured at the section; KF1 to KF3
 * are the three flood-alert grades; Npt is the gauge datum. They are the context this
 * project has been missing: "112 m3/s" says nothing, "8 cm above the lowest ever
 * recorded here" says everything.
 *
 * They are stage in centimetres, which is why the poll now asks for stage as well.
 * Printed as a paste-ready block because they are reference values that change rarely -
 * a record is broken, a grade is revised - and fetching them on every poll would spend
 * a request on data that is static between such events.
 */
/**
 * Find the gauges that measure standing water.
 *
 * The balance is built out of rivers, but "how is Hungary's water doing" is a question
 * most people answer by looking at the Balaton. Lake gauges are in the same catalogue as
 * river ones, so this is a search rather than a new integration - but which vmoType
 * carries them is not documented anywhere we can read, so it sweeps a range and prints
 * whatever it finds whole.
 */
const LAKE_PATTERN = /balaton|fert[őo]|velencei|tisza-t[óo]|kisk[őo]re|tározó|-t[óo]\b|^t[óo]\b/i;

/**
 * Standing water lives in vmoType 11 alongside the rivers - 13 turned out to be
 * groundwater wells and 14 meteorology, neither of which measures a lake surface. What
 * distinguishes a lake gauge is its MdrNev: "Balaton" rather than "Duna".
 */
async function probeLakes() {
  console.log('\n########## lake gauges ##########');

  // Only the four that matter, and only the fields needed to register a gauge. The full
  // dump ran to thousands of lines and scrolled off the top of the log, which is worse
  // than no output: it looks like an answer.
  const LAKES = [/balaton/i, /velencei/i, /fert[őo]/i, /tisza-t[óo]|kisk[őo]rei/i];
  const { rows } = await fetchCatalogue(11, { internetOnly: true });

  const waters = [...new Set(rows.map((r) => r.MdrNev).filter(Boolean))];
  console.log(`${rows.length} published gauges, ${waters.length} distinct waters`);
  console.log(`standing water named in the catalogue: ${waters.filter((w) => LAKES.some((re) => re.test(w))).join(' | ') || '(none)'}`);

  const show = (h) =>
    console.log(
      `  Tsz ${String(h.Tsz).padEnd(8)} ${String(h.Nev).padEnd(34)} ` +
        `${h.Lat != null ? h.Lat.toFixed(4) : '     ?'},${h.Lon != null ? h.Lon.toFixed(4) : '?'} ` +
        `Npt=${h.Npt ?? '-'} LKV=${h.LKV ?? '-'} LNV=${h.LNV ?? '-'} ` +
        `KF=${h.KF1 ?? '-'}/${h.KF2 ?? '-'}/${h.KF3 ?? '-'} Fkm=${h.Fkm ?? '-'} vizig=${h.Vizig} [${h.MdrNev}]`,
    );

  for (const re of LAKES) {
    const hits = rows.filter((row) => re.test(String(row.MdrNev ?? '')));
    console.log(`\n${re} -> ${hits.length} gauges`);
    for (const h of hits) show(h);
  }

  // The Tisza-tó is a reservoir, so its level is the Kisköre barrage's upper pool - a
  // Tisza gauge, not a lake one. The only thing the catalogue files under "Tisza-tó" is
  // a seepage canal, which is a different body of water entirely.
  console.log('\nKisköre and other barrage pools on the Tisza:');
  for (const h of rows.filter((r) => /kisk[őo]re|tiszal[őo]k|b[őo]kény|nagyk[őo]r[űu]/i.test(String(r.Nev ?? '')))) show(h);
}

/**
 * What kinds of measurement exist at all.
 *
 * We use 87 (discharge) and 68 (stage) because those are the two we needed. A lake has
 * no discharge, and the interesting series there are level and water temperature - so
 * before assuming a code, ask.
 */
async function probeDataTypes() {
  console.log('\n########## data type catalogue ##########');
  const token = await createTokenProvider().getToken();

  // Both prefixes: an earlier copy of this probe asked /Base/... and this one /Vra/...,
  // and neither of us knew which was right because the duplicate meant only one ever ran.
  const paths = [
    '/Vra/AdatFajta', '/Vra/AdatFajtak', '/Vra/AdatTipus', '/Vra/AdatTipusok', '/Vra/Mertekegyseg',
    '/Base/AdatFajta', '/Base/AdatTipus', '/Base/Mertekegyseg',
  ];
  for (const path of paths) {
    const url = `${VRAQUERY_BASE}${path}`;
    try {
      const rows = await fetchJson(url, {
        timeoutMs: 30000,
        headers: { Authorization: `Bearer ${token}`, ...browserHeaders('https://data.vizugy.hu') },
      });
      const list = Array.isArray(rows) ? rows : [rows];
      console.log(`\n${url}: ${list.length} entries`);
      for (const row of list.slice(0, 60)) console.log(`  ${JSON.stringify(row)}`);
    } catch (err) {
      console.log(`\n${url}: FAILED ${err.message}`);
    }
  }
}

/**
 * Every operation the service documents.
 *
 * A forecast is the single most valuable thing this project does not have, and it is
 * unlikely to be a separate integration: the query service already returns time series
 * by data-type code, so a forecast is most probably another AdatTipusKod on the endpoint
 * we already call. This lists the whole contract so that guess can be checked rather
 * than assumed.
 */
async function probeOperations() {
  console.log('\n########## every documented operation ##########');
  try {
    const spec = await fetchJson(OPENAPI_URL, {
      timeoutMs: 30000,
      headers: browserHeaders('https://vmservice.vizugy.hu', `${VRAQUERY_BASE}/swagger/index.html`),
    });
    for (const line of summarizeOperations(spec)) console.log(`  ${line}`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

async function probeThresholds() {
  console.log('\n########## stage thresholds (LKV / LNV / flood grades) ##########');
  const { EXTERNAL_IDS } = require('../sources/vizugy');
  const byTsz = new Map(Object.entries(EXTERNAL_IDS).map(([id, tsz]) => [String(tsz), id]));

  for (const internetOnly of [true, false]) {
    try {
      const { rows } = await fetchCatalogue(11, { internetOnly });
      const hits = rows.filter((row) => byTsz.has(String(row.Tsz ?? row.Torzsszam)));
      console.log(`\n${internetOnly ? 'InternetVmo' : 'Vmo'}: ${hits.length} of ${byTsz.size} stations found`);

      for (const row of hits) {
        const id = byTsz.get(String(row.Tsz ?? row.Torzsszam));
        const has = ['LKV', 'LNV', 'KF1', 'KF2', 'KF3', 'Npt'].some((k) => row[k] !== undefined && row[k] !== null);
        if (!has) continue;
        console.log(
          `  '${id}': { lkv: ${row.LKV ?? 'null'}, lnv: ${row.LNV ?? 'null'},` +
            ` kf1: ${row.KF1 ?? 'null'}, kf2: ${row.KF2 ?? 'null'}, kf3: ${row.KF3 ?? 'null'},` +
            ` datum: ${row.Npt ?? 'null'} },`,
        );
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
  console.log('\nAll centimetres of stage, relative to the gauge datum (Npt, metres above sea level).');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--thresholds')) {
    await probeThresholds();
    return;
  }

  if (args.includes('--lakes')) {
    await probeLakes();
    return;
  }

  if (args.includes('--datatypes')) {
    await probeDataTypes();
    return;
  }

  if (args.includes('--operations')) {
    await probeOperations();
    return;
  }

  if (args.includes('--mavir-sheet')) {
    await probeMavirSheet();
    return;
  }

  const siteArg = args.find((a) => a.startsWith('--site='));
  if (siteArg) {
    await probeSite(siteArg.split('=').slice(1).join('='));
    return;
  }

  if (args.includes('--entsoe')) {
    await probeEntsoe();
    return;
  }

  if (args.includes('--live')) {
    await probeAllStations();
    return;
  }

  const findArg = args.find((a) => a.startsWith('--find='));
  if (findArg) {
    await probeFind(findArg.split('=').slice(1).join('='));
    return;
  }

  const urlArg = args.find((a) => a.startsWith('--url='));
  if (urlArg) {
    await probeUrl(urlArg.split('=')[1], 'custom URL');
    return;
  }

  const pageArg = args.find((a) => a.startsWith('--page='));
  if (pageArg) {
    await discover(pageArg.split('=')[1]);
    return;
  }

  const doAll = !args.some((a) => a === '--vizugy' || a === '--mavir');

  if (doAll || args.includes('--vizugy')) {
    const cfg = vizugy.config();
    console.log('\n########## data.vizugy.hu ##########');
    console.log(`Currently configured: ${vizugy.seriesUrl(cfg)} haf=${cfg.hafCode} at=${cfg.atCode}`);

    // The endpoints are no longer in question. The portal's bundle gave up the auth
    // flow and the two calls it makes, and the swagger initialiser named the OpenAPI
    // document. So the default run reads the contract and the catalogue rather than
    // re-mining megabytes of minified code; `--discover` still does the mining when
    // something upstream changes and the contract stops matching.
    await probeOpenApi();
    await probeDataTypes();
    await probeCatalogue(11);
    await probeSeries(1, 'Rajka');
    await probeAllStations();

    // Confirms the anonymous token still works, and that it still needs the headers a
    // browser sends - the 403 without them looks like a permissions problem and is not.
    console.log('\n########## vizugy auth ##########');
    await probeUrl('https://data.vizugy.hu/AuthApi/auth/token', 'token (plain)');
    await probeUrl('https://data.vizugy.hu/AuthApi/auth/token', 'token (portal headers)', {
      headers: browserHeaders('https://data.vizugy.hu'),
    });

    if (args.includes('--discover')) {
      await discover('https://data.vizugy.hu/', {
        keywords: ['loadStations', '_apiRootUrl', 'getStationData', 'postLastData', 'setRequest'],
      });
      await discover(`${VRAQUERY_BASE}/swagger/index.html`, { keywords: ['SwaggerUIBundle'] });
      await fetchDocs([
        'https://vmservice.vizugy.hu/vmhelp/',
        'https://vmservice.vizugy.hu/vmhelp/Funkcioleiras.html',
        'https://vmservice.vizugy.hu/vmhelp/Katalogustaroltnapiadatoklekerde.html',
      ]);
    }
  }

  if (doAll || args.includes('--mavir')) {
    const cfg = mavir.config();
    console.log('\n########## mavir.hu ##########');
    console.log(`Currently configured: ${cfg.baseUrl}${cfg.path} chartId=${cfg.chartId}`);

    // The portal page carries no data - it is Liferay, and its fourteen inline blocks
    // are all framework. What it does carry is the iframe, and the iframe is the
    // application that holds the endpoint:
    //
    //   https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab7679
    //
    // tab7679 is system load; the generation mix this project needs is on its own tab.
    // Going straight at the servlet skips 23 KB of portal boilerplate.
    const CHART_TABS = [
      { tab: 'tab7679', what: 'system load (rendszerterhelés)' },
      { tab: 'tab4402', what: 'real-time generation mix' },
    ];

    console.log('\n########## mavir chart servlet ##########');
    for (const { tab, what } of CHART_TABS) {
      const url = `https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=${tab}`;
      console.log(`\n--- ${tab}: ${what} ---`);

      // The servlet is framed by the portal, so it expects the portal as the referrer.
      await probeUrl(url, `${tab} body`, {
        maxChars: 6000,
        headers: browserHeaders('https://www.mavir.hu', 'https://www.mavir.hu/web/mavir/rendszerterheles'),
      });

      await discover(url, {
        keywords: ['getExportFile', 'exportType', 'periodType', 'getChartImageInterval'],
        depth: 0,
        radius: 700,
      });
    }

    await probeMavirExport();

    // The publication app's own root, in case the servlet is only a renderer and the
    // data lives beside it.
    console.log('\n########## mavir publication app ##########');
    await discover('https://rtdwweb.mavir.hu/rtdwweb/webuser/', {
      keywords: ['getData', 'DataServlet', 'tabId', 'ajax', 'json'],
    });

    // The portal pages, last: they are the least informative and the noisiest, but a
    // second tab id or a changed frame URL would show up here first.
    if (args.includes('--portal')) {
      for (const page of [
        'https://www.mavir.hu/web/mavir/rendszerterheles',
        'https://www.mavir.hu/web/mavir/valos-ideju-aggregalt-termeles',
      ]) {
        await discover(page, { depth: 1 });
      }
    }
  }

  console.log('\nRecord what returned JSON in .env, then run `npm run poll` to verify the ingest.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { probeUrl };
