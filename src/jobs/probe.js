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
  const { getLake } = require('../config/lakes');
  const result = await vizugy.fetchAll();

  // The same call now returns lakes as well, and a lake is not in the station registry
  // and has no discharge to compare against a mean. Printed separately rather than
  // skipped: a lake missing from the response is exactly as interesting as a gauge is.
  const rows = Object.values(result.readings)
    .filter((reading) => getStation(reading.stationId))
    .map((reading) => {
      const station = getStation(reading.stationId);
      return {
        station,
        reading,
        ratio: station.meanFlow ? reading.flowM3s / station.meanFlow : null,
      };
    })
    .sort((a, b) => b.reading.flowM3s - a.reading.flowM3s);

  const lakeRows = Object.values(result.readings).filter((reading) => getLake(reading.stationId));

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

  for (const { stationId, waterLevelCm, timestamp } of lakeRows) {
    console.log(`  ${stationId.padEnd(28)} ${'lake'.padEnd(9)} ${String(waterLevelCm).padStart(9)} cm   ${timestamp}`);
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
  if (cfg.tokenError) {
    // Worth its own branch: this looks identical to a wrong token from the server's
    // side - three HTTP 401s - and is a paste artefact rather than a credentials problem.
    console.log(cfg.tokenError);
    console.log(`The stored value is ${String(process.env.ENTSOE_TOKEN || '').length} characters long ` +
      `across ${String(process.env.ENTSOE_TOKEN || '').split('\n').length} line(s); it should be one line.`);
    return;
  }
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

    // 169 MW of nuclear is not a reading, it is a bug: Paks I is four 500 MW units on
    // baseload. The suspicion is the ragged publication edge - each fuel is summed at
    // its OWN last point, so a fuel that publishes later than the others contributes a
    // partial interval to a mix that looks like one moment. Print each series' tail so
    // the guess becomes a measurement.
    const raw = await entsoe.fetchGenerationRaw();
    console.log('\nPer-series tail, to see whether the edge is ragged:');
    for (const [key, points] of Object.entries(raw.byType)) {
      const tail = points.slice(-4).map((p) => `${p.timestamp.slice(11, 16)}=${p.mw}`).join('  ');
      console.log(`  ${key.padEnd(14)} ${String(points.length).padStart(4)} pts   ${tail}`);
    }
  } catch (err) {
    console.log(`A75 FAILED: ${entsoe.describeError(err)}`);
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
    console.log(`A73 FAILED: ${entsoe.describeError(err)}`);
    console.log(`  reason: ${(/<Reason>[\s\S]*?<\/Reason>/i.exec(err.body || '') || ['(no Reason element)'])[0].replace(/\s+/g, ' ')}`);
  }

  try {
    // The plant list is not optional - fetchAvailability iterates it. Calling it bare
    // reported "plants is not iterable", which reads like an upstream failure and is a
    // probe bug.
    const availability = await entsoe.fetchAvailability(require('../config/powerplants').listPlants('operating'));
    console.log(`\nA80 outages: ${availability.activeOutages} active of ${availability.outageCount} published`);
    console.log(JSON.stringify(availability.availability, null, 2));
  } catch (err) {
    console.log(`A80 FAILED: ${entsoe.describeError(err)}`);
    console.log(`  reason: ${(/<Reason>[\s\S]*?<\/Reason>/i.exec(err.body || '') || ['(no Reason element)'])[0].replace(/\s+/g, ' ')}`);
  }

  // The nuclear series came back a flat 168 MW for a full day, which is not Paks and is
  // not a parsing fault either - the series really says that. The mix sums to about
  // 4 400 MW against a Hungarian morning load nearer 6 000, and the gap is roughly the
  // size of Paks. So the question is whether B14 in this document is the whole fleet.
  // A65 (total load) is the cross-check that settles it: if load is 6 000 while the mix
  // is 4 400, the mix is incomplete rather than the country being short of power.
  try {
    const cfg2 = entsoe.config();
    const now = new Date();
    const url = entsoe.buildUrl(cfg2, {
      from: new Date(now.getTime() - 6 * 3600 * 1000),
      to: new Date(now.getTime() + 3600 * 1000),
      documentType: 'A65',
      processType: 'A16',
      domainParam: 'outBiddingZone_Domain',
    });
    const { body } = await require('../lib/http').fetchText(url, { timeoutMs: 30000 });
    const loads = [...body.matchAll(/<quantity>([\d.]+)<\/quantity>/g)].map((m) => Number(m[1]));
    console.log(`\nA65 total load, last few: ${loads.slice(-4).join(', ')} MW`);
    console.log('If load is far above the generation mix, the mix is missing a fleet.');
  } catch (err) {
    console.log(`\nA65 FAILED: ${entsoe.describeError(err)}`);
    console.log(`  raw body: ${JSON.stringify(String(err.body || '(empty)').slice(0, 300))}`);
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
  // ok=false has been the steady state, so the count is the part worth reading. One or
  // two is a quiet gauge; twenty is the upstream being down, and the flag alone cannot
  // tell those apart.
  if (meta.lastPollErrors) {
    console.log(`  poll errors   ${meta.lastPollErrors.count}` +
      (meta.lastPollErrors.count ? `   ${meta.lastPollErrors.first
        .map((e) => String(e && e.station || e).slice(0, 40)).join(' | ')}` : ''));
  }

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

  // The sections that are not in the snapshot.
  //
  // /snapshot answering correctly says nothing about a route added since - and a new
  // endpoint that 500s in production is invisible from here, because the page renders
  // the rest of itself perfectly well without it. Each one is checked for the field that
  // proves it did real work, not merely for HTTP 200: this project has been fooled by a
  // 200 with an empty body more than once.
  console.log('\n  the sections that are not in /snapshot:');
  const extras = [
    ['groundwater', '/api/v1/groundwater', (d) => {
      const s = d.summary || {};
      if (!s.registered) return { ok: false, note: 'no wells registered' };
      if (!s.comparable) return { ok: false, note: `${s.registered} wells, none comparable - the bake or the feed is missing` };
      return { ok: true, note: `${s.comparable}/${s.registered} comparable, ${s.low} low, ${s.recordLow} at a ten-year low` };
    }],
    // The drought section carries its own verdict on whether it can be trusted, so the
    // deployment check reads that rather than re-deriving it. A section that has gone
    // quiet still answers 200 with a full payload - that is the entire failure mode.
    ['drought', '/api/v1/drought', (d) => {
      const s = d.summary || {};
      const h = d.health || {};
      if (!s.registered) return { ok: false, note: 'no stations registered' };
      if (!h.ok) {
        return { ok: false, note: `SILENT: ${(h.reasons || []).map((r) => r.code).join(', ')}` +
          `${h.quietDays != null ? ` (newest reading ${h.quietDays}d old)` : ''}` };
      }
      return { ok: true, note: `${s.comparable}/${s.registered} comparable, ${s.dry} dry, ` +
        `${s.deepestOnRecord} at a ten-year low, freshest ${String(h.freshestAt).slice(0, 16)}` };
    }],
    ['rainfall', '/api/v1/rainfall?days=30', (d) => {
      const gauges = Object.keys(d.gauges || {}).length;
      return { ok: gauges > 0, note: `${gauges} gauges` };
    }],
    // /archive, not /api/v1/archive: it is mounted outside the API version on purpose,
    // because a dated URL published today has to still resolve in ten years and /api/v1
    // is a promise about a response shape rather than about permanence. Probing the
    // versioned path reported a 404 against a perfectly healthy endpoint - a check that
    // cries wolf is worse than no check, because the next real failure gets ignored.
    // Added with the sections themselves, not after one of them was found dark in
    // production. Both check a field that only exists if the work actually happened.
    ['szennyviz', '/api/v1/szennyviz?limit=1', (d) => {
      if (!d.count) return { ok: false, note: 'no plants - the register is not in the deployment' };
      return { ok: d.totalM3s > 0, note: `${d.count} works, ${d.totalM3s} m3/s, ` +
        `${Math.round((d.volumeCapacityShare || 0) * 100)}% of capacity has a volume` };
    }],
    ['talajnedvesseg', '/api/v1/talajnedvesseg', (d) => {
      if (!d.count) return { ok: false, note: 'no stations - the registry is not in the deployment' };
      // measuredCount, not count: the registry ships with the build and would report 23
      // whether or not a single station answered, which is the one failure that matters.
      return { ok: d.measuredCount > 0, note: `${d.measuredCount}/${d.count} reporting, ` +
        `${d.dryCount} in their own lowest quarter, record ${d.recordYears} year(s)` };
    }],
    ['ipari', '/api/v1/ipari?limit=1', (d) => {
      if (!d.count) return { ok: false, note: 'no outfalls - the register is not in the deployment' };
      // The vintage is checked, not just the count. A register whose date stopped
      // travelling with it would render as a claim about today, and that is the one
      // failure on this layer that would look completely fine.
      return { ok: !!d.vintage && d.surfaceCount + d.groundwaterCount === d.count,
        note: `${d.count} outfalls, ${d.groundwaterCount} to groundwater, ${d.sectors.length} sectors` };
    }],
    // The one endpoint here that reaches a THIRD host at request time. Vercel's egress to
    // the geoportal is not something any local test can prove, so it is proved here.
    ['vizhiany', '/api/v1/vizhiany', (d) => {
      const s = d.summary || {};
      if (!s.total) return { ok: false, note: 'no districts - the geoportal fetch failed in production' };
      return { ok: s.graded > 0, note: `${s.graded}/${s.total} graded, ${s.atExtraordinary} at the ` +
        `extraordinary grade, newest ${String(s.newestUpdate).slice(0, 10)}` };
    }],
    ['archive', '/archive', (d) => ({
      ok: Array.isArray(d.days) ? d.days.length > 0 : Boolean(d),
      note: Array.isArray(d.days) ? `${d.days.length} days` : 'responded',
    })],
    // The drainage chain. Checked on a real stream rather than on the count, because the
    // failure that matters is the index being absent from the deployment - which returns
    // a perfectly well-formed 404 and looks like a typo in the slug.
    ['viz', '/api/v1/viz/ilona-patak', (d) => {
      const steps = ((d.downstream || {}).steps || []).map((s) => s.name);
      return { ok: d.available === true && steps.length > 0,
        note: steps.length ? `${d.name} → ${steps.join(' → ')}` : 'no chain - is watercourses.json deployed?' };
    }],
    ['aszalyevek', '/api/v1/aszalyevek', (d) => {
      const s = d.summary || {};
      return { ok: d.available === true && s.comparable > 0,
        note: `${d.monthHu}: ${s.belowReference}/${s.comparable} below ${d.reference}, ${(d.years || []).length} years` };
    }],
  ];

  for (const [name, path, check] of extras) {
    try {
      const body = await fetchJson(`${base}${path}`, { timeoutMs: 30000 });
      const { ok, note } = check(body);
      console.log(`    ${name.padEnd(14)} ${ok ? 'OK  ' : 'EMPTY'}  ${note}`);
    } catch (err) {
      console.log(`    ${name.padEnd(14)} FAIL  ${err.message.split('\n')[0]}`);
    }
  }

  // The static documents the map fetches on demand. A 4.7 MB file is exactly the kind of
  // thing a host quietly declines to serve, and the page degrades silently when it does -
  // the layer simply never appears and nothing anywhere reports an error.
  console.log('\n  the map\'s on-demand documents:');
  for (const [name, path, key] of [
    ['waters.json', '/waters.json', 'features'],
    ['vizhiany.json', '/vizhiany.json', 'districts'],
    ['geo.json', '/geo.json', 'rivers'],
  ]) {
    try {
      const body = await fetchJson(`${base}${path}`, { timeoutMs: 60000 });
      const n = Array.isArray(body[key]) ? body[key].length : 0;
      console.log(`    ${name.padEnd(14)} ${n > 0 ? 'OK  ' : 'EMPTY'}  ${n} ${key}`);
    } catch (err) {
      console.log(`    ${name.padEnd(14)} FAIL  ${err.message.split('\n')[0].slice(0, 80)}`);
    }
  }

  // The two surfaces that are not JSON, and both are the kind that fail invisibly.
  //
  // The share card is fetched by a crawler and never by a reader, so a broken one is
  // discovered by seeing a link with no picture on somebody else's timeline. The
  // watercourse page is a server-rendered route at the site root, which is exactly the
  // shape of thing Vercel serves as a static-file 404 when its rewrite is missing - the
  // same failure that hid /archive and /feed.xml for months.
  console.log('\n  the two non-JSON surfaces:');
  const { fetchText: fetchRaw } = require('../lib/http');
  try {
    const res = await fetch(`${base}/share/card.png`, { signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf.length > 8 && buf.slice(1, 4).toString('ascii') === 'PNG';
    console.log(`    card.png       ${isPng ? 'OK  ' : 'FAIL'}  HTTP ${res.status} ` +
      `${res.headers.get('content-type')} ${buf.length}B` +
      `${isPng ? '' : ' - og:image is not a PNG, so no preview on Facebook, X or LinkedIn'}`);
  } catch (err) {
    console.log(`    card.png       FAIL  ${err.message.split('\n')[0].slice(0, 80)}`);
  }
  try {
    const html = await fetchRaw(`${base}/viz/rakos-patak`, { timeoutMs: 30000 });
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const named = /Rákos-patak/.test(title);
    console.log(`    /viz/:slug     ${named ? 'OK  ' : 'FAIL'}  title: ${title.slice(0, 60) || '(none)'}`);
  } catch (err) {
    console.log(`    /viz/:slug     FAIL  ${err.message.split('\n')[0].slice(0, 80)}`);
  }
}

/**
 * Download the generation export once and print the grid.
 *
 * The column names are the whole remaining question: they have to be matched against
 * the plant registry, and guessing at them is how one plant's output gets attributed to
 * another. One request, because twenty took the host to 429 and kept it there.
 */
/**
 * Which chart carries the per-source-type mix.
 *
 * Chart 4401 is configured as "Erőművi termelés" and returns four national totals -
 * gross planned, gross actual, net planned, net actual - with no breakdown by fuel at
 * all. Nothing in it resolves to a source type, so every plant falls through to
 * `unavailable` and the whole cooling model goes dark. Whether 4401 changed under us or
 * was always the wrong chart does not matter; the fix is the same, and it needs the id
 * of the chart that does carry the mix.
 *
 * ONE request. The chart list is in the servlet page as data-chart-id attributes, and
 * this host answers a burst with a 429 that takes the whole site down with it.
 */
async function probeMavirCharts() {
  console.log('\n########## mavir chart catalogue ##########');
  const { fetchText, browserHeaders } = require('../lib/http');
  const url = 'https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab4402';

  let html;
  try {
    // fetchText returns { body, contentType }, not a string - the first version of this
    // called .matchAll on the wrapper object and died on the first line.
    ({ body: html } = await fetchText(url, {
      timeoutMs: 30000,
      headers: browserHeaders('https://rtdwweb.mavir.hu'),
    }));
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    console.log('A 429 means the host is rate limited - wait, do not retry in a loop.');
    return;
  }

  // Each option carries the id and a data-content blob with the human label in it.
  const seen = new Map();
  for (const m of html.matchAll(/data-chart-id="(\d+)"([\s\S]{0,400}?)(?=data-chart-id="|<\/select>|$)/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    // The label is the longest run of non-markup text in the blob.
    const text = m[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    seen.set(id, text.slice(0, 120));
  }

  console.log(`${seen.size} charts on tab4402\n`);
  for (const [id, label] of seen) console.log(`  ${id}  ${label}`);
  console.log('\nThe one to want is a generation MIX - fuel types, not national totals.');
  console.log('Re-run with --mavir-sheet after setting MAVIR_CHART_ID, or probe one directly:');
  console.log('  npm run probe -- --mavir-sheet --chart=<id>');
}

async function probeMavirSheet(args = []) {
  const chart = (args.find((a) => a.startsWith('--chart=')) || '').slice(8);
  if (chart) process.env.MAVIR_CHART_ID = chart;
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
  const out = {};
  for (const path of paths) {
    const url = `${VRAQUERY_BASE}${path}`;
    try {
      const rows = await fetchJson(url, {
        timeoutMs: 30000,
        headers: { Authorization: `Bearer ${token}`, ...browserHeaders('https://data.vizugy.hu') },
      });
      const list = Array.isArray(rows) ? rows : [rows];
      out[path] = list;
      console.log(`\n${url}: ${list.length} entries`);
      // All of them, not the first 60. The catalogue is 68 entries long and the cut at 60
      // silently hid the last eight, which are alphabetically the T-Z ones - among them
      // Talajnedvesség, the soil-moisture measurement this project spent a whole probe
      // concluding it could not have.
      for (const row of list) console.log(`  ${JSON.stringify(row)}`);
    } catch (err) {
      out[path] = { error: err.message.split('\n')[0] };
      console.log(`\n${url}: FAILED ${err.message}`);
    }
  }

  // Written out, not only logged. This catalogue is the map of everything this API can
  // be asked for - 68 quantities, of which this project reads six - and until now it
  // existed only in a job log that expires in a fortnight, so every question about "is
  // there data for X" started by probing for it again.
  emitDocument('adatfajtak', out, 'reference - which AdatFajtaKod values exist at all');
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

/**
 * Does the forecast series actually contain anything?
 *
 * The catalogue lists AdatTipusKod 5 as "előrejelzett", which would mean a forecast costs
 * us one extra block on a request we already make. A code existing in a catalogue is not
 * the same as a series being populated, though, so this asks for real stations and prints
 * what comes back - specifically whether any sample carries a timestamp in the future,
 * which is the only thing that makes it a forecast rather than another copy of the past.
 */
/** POST a TsShort body and hand back the rows. One place, so every probe below agrees. */
async function askSeries(body, { timeoutMs = 30000 } = {}) {
  const token = await createTokenProvider().getToken();
  return fetchJson(`${VRAQUERY_BASE}/TS/TsShort`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...browserHeaders('https://data.vizugy.hu'),
    },
  });
}

/** Non-null samples from a response entry, oldest first. */
function usable(entry) {
  return ((entry && entry.TsItemList) || [])
    .filter((i) => i && i.Adat !== null && i.Adat !== undefined && i.Adat !== '')
    .sort((a, b) => new Date(a.UTCTime) - new Date(b.UTCTime));
}

/** One line describing what a series contained. */
function describeSeries(items, now) {
  if (!items.length) return 'empty';
  const ahead = items.filter((i) => new Date(i.UTCTime) > now);
  const first = items[0];
  const last = items[items.length - 1];
  return (
    `${String(items.length).padStart(4)} samples  ${first.UTCTime.slice(0, 16)} → ${last.UTCTime.slice(0, 16)}  ` +
    `last=${last.Adat}` +
    (ahead.length ? `  ${ahead.length} AHEAD OF NOW, to ${ahead[ahead.length - 1].UTCTime.slice(0, 16)}` : '')
  );
}

/**
 * Does the forecast series actually contain anything?
 *
 * A batch of six stations under AdatTipusKod 5 answered HTTP 500, which says nothing
 * about whether a forecast exists - a single unsupported station fails the whole POST,
 * and one request cannot tell you which. So this asks one station at a time, and asks
 * each of the plausible codes, so a 500 is attributable to a station-and-code pair
 * rather than to "the forecast".
 *
 * The test for a forecast is not that the call succeeds. It is that a sample carries a
 * timestamp in the future; anything else is another copy of the past.
 */
async function probeForecast() {
  console.log('\n########## forecast ##########');
  const { EXTERNAL_IDS } = require('../sources/vizugy');
  const now = new Date();

  // Stage rather than discharge: a forecast, where it exists, is published as a
  // predicted water level, because that is what a flood warning is expressed in.
  const wanted = ['duna-komarom', 'duna-budapest', 'duna-mohacs', 'tisza-szolnok', 'tisza-szeged'];

  // 5 is "előrejelzett" in /Base/AdatTipus. The others are the codes whose names leave
  // room for a prediction, asked here so the answer is measured rather than assumed.
  const CODES = [
    [5, 'előrejelzett'],
    [15, 'becsült'],
    [6, 'számított'],
    [100, 'operatív (control)'],
  ];

  for (const [atCode, label] of CODES) {
    console.log(`\n--- AdatTipusKod ${atCode} (${label}) ---`);

    for (const id of wanted) {
      for (const [haf, unit] of [[68, 'stage cm'], [87, 'flow m3/s']]) {
        const body = [
          {
            ItemId: 0,
            Torzsszam: Number(EXTERNAL_IDS[id]),
            AdatFajtaKod: haf,
            AdatTipusKod: atCode,
            StartTime: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
            EndTime: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
          },
        ];

        const tag = `  ${id.padEnd(15)} ${unit.padEnd(10)}`;
        try {
          const rows = await askSeries(body);
          const entries = Array.isArray(rows) ? rows : [];
          console.log(`${tag} ${entries.length ? describeSeries(usable(entries[0]), now) : 'no entry returned'}`);
        } catch (err) {
          console.log(`${tag} FAILED ${err.message}`);
        }
      }
    }
  }
}

/**
 * Groundwater wells: what exists, and which of them answer.
 *
 * vmoType 13 is the well network. Groundwater is the half of the Hungarian water
 * situation that surface gauges cannot see - the Danube can be running a normal August
 * while the water table under the Homokhátság is at a record low, and it is the table
 * that decides whether a maize crop survives.
 *
 * Two things have to be established before a well can go in a registry: that it returns
 * a series at all (many are quarterly manual dips, not telemetry), and what its numbers
 * mean, because AdatFajtaKod 69 is "talajvízállás" in centimetres and the sign convention
 * - depth below the surface, or elevation above a datum - decides whether a bigger number
 * is more water or less.
 */
async function probeGroundwater() {
  console.log('\n########## groundwater wells (vmoType 13) ##########');

  let rows = [];
  for (const internetOnly of [true, false]) {
    try {
      const res = await fetchCatalogue(13, { internetOnly });
      console.log(`${res.url}: ${Array.isArray(res.rows) ? res.rows.length : 'not an array'} entries`);
      if (internetOnly && Array.isArray(res.rows)) rows = res.rows;
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
  }
  if (!rows.length) return;

  console.log(`\nOne record, in full:\n${JSON.stringify(rows[0], null, 2)}`);

  const byVizig = new Map();
  for (const row of rows) byVizig.set(row.Vizig, (byVizig.get(row.Vizig) || 0) + 1);
  console.log(`\nwells per directorate: ${[...byVizig].map(([v, n]) => `${v}:${n}`).join('  ')}`);

  // One well per directorate, so the sample spans the country rather than one basin -
  // the point of a groundwater layer is regional contrast.
  const sample = [];
  for (const [vizig] of byVizig) {
    const pick = rows.find((r) => r.Vizig === vizig && r.Lat != null && r.Lon != null);
    if (pick) sample.push(pick);
  }
  console.log(`\nAsking ${sample.length} wells, one per directorate, AdatFajtaKod 69 (talajvízállás), 90 days:`);

  const now = new Date();
  const start = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();

  for (const [haf, label] of [[69, 'talajvízállás'], [299, 'talajnedvesség'], [70, 'rétegvízszint']]) {
    console.log(`\n--- AdatFajtaKod ${haf} (${label}) ---`);
    try {
      const rowsOut = await askSeries(
        sample.map((well, index) => ({
          ItemId: index,
          Torzsszam: Number(well.Tsz),
          AdatFajtaKod: haf,
          AdatTipusKod: 100,
          StartTime: start,
          EndTime: new Date(now.getTime() + 3600 * 1000).toISOString(),
        })),
      );
      const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(rowsOut) ? rowsOut : []);
      sample.forEach((well, index) => {
        const items = usable(byItemId.get(index));
        console.log(
          `  Tsz ${String(well.Tsz).padEnd(8)} ${String(well.Nev).slice(0, 26).padEnd(26)} ` +
            `${well.Vizig}  ${describeSeries(items, now)}`,
        );
      });
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
  }
}

/**
 * Every published rain gauge, asked whether it is actually reporting.
 *
 * The one-per-directorate sample answered at six of eleven, which is enough to know the
 * series exists and not enough to build a registry on: a gauge that stopped reporting in
 * 2019 is still in the catalogue, and a drought map with holes in it is worse than no map.
 * So this asks all of them and reports only the ones with a sample in the last three days.
 *
 * It also asks how far the archive reaches, because a rainfall total means nothing without
 * a normal to compare it against. If the same gauge can be asked for the same weeks in
 * earlier years, the normal is measured rather than hardcoded from a yearbook.
 */
async function probeRainScan() {
  console.log('\n########## rain gauge scan ##########');

  const { rows } = await fetchCatalogue(14, { internetOnly: true });
  const usableRows = rows.filter((r) => r.Lat != null && r.Lon != null);
  console.log(`${rows.length} published met stations, ${usableRows.length} with coordinates`);

  const now = new Date();
  const start = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString();
  const end = new Date(now.getTime() + 3600 * 1000).toISOString();
  const live = [];

  // Chunked so one bad station cannot take the whole scan down with it.
  const CHUNK = 50;
  for (let offset = 0; offset < usableRows.length; offset += CHUNK) {
    const batch = usableRows.slice(offset, offset + CHUNK);
    try {
      const out = await askSeries(
        batch.map((station, index) => ({
          ItemId: index,
          Torzsszam: Number(station.Tsz),
          AdatFajtaKod: 71,
          AdatTipusKod: 100,
          StartTime: start,
          EndTime: end,
        })),
        { timeoutMs: 60000 },
      );
      const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
      batch.forEach((station, index) => {
        const items = usable(byItemId.get(index));
        if (!items.length) return;
        const last = new Date(items[items.length - 1].UTCTime);
        if (now - last > 3 * 24 * 3600 * 1000) return;
        live.push({
          station,
          samples: items.length,
          sum: items.reduce((total, i) => total + Number(i.Adat), 0),
          last: items[items.length - 1].UTCTime,
        });
      });
    } catch (err) {
      console.log(`  chunk at ${offset}: FAILED ${err.message}`);
    }
  }

  console.log(`\n${live.length} gauges reported within the last three days.\n`);

  const byVizig = new Map();
  for (const row of live) {
    if (!byVizig.has(row.station.Vizig)) byVizig.set(row.station.Vizig, []);
    byVizig.get(row.station.Vizig).push(row);
  }

  for (const vizig of [...byVizig.keys()].sort((a, b) => a - b)) {
    const group = byVizig.get(vizig).sort((a, b) => b.samples - a.samples);
    console.log(`--- Vízügyi igazgatóság ${vizig}: ${group.length} live gauges ---`);
    for (const row of group.slice(0, 6)) {
      const { station } = row;
      console.log(
        `  ${String(station.Tsz).padEnd(8)} ${String(station.Nev).slice(0, 28).padEnd(28)} ` +
          `${station.Lat.toFixed(3)},${station.Lon.toFixed(3)}  ` +
          `${String(row.samples).padStart(4)} samples  35d sum ${row.sum.toFixed(1).padStart(6)} mm  last ${row.last.slice(0, 16)}`,
      );
    }
  }

  // The met network is not national. Directorates 2 (Budapest) and 4 (Székesfehérvár)
  // have no meteorological stations in the catalogue at all, and 5 (Pécs) has 22 of which
  // none reported - so on this network alone, Transdanubia is a hole and the Alföld is
  // dense. A drought map that stops at the Danube is not a map of Hungary.
  //
  // Many river gauges have a rain gauge on the same post, though, and those live in
  // vmoType 11. If they publish code 71 the hole closes, so ask before accepting it.
  console.log('\n--- surface gauges (vmoType 11) asked for rainfall ---');
  const surface = (await fetchCatalogue(11, { internetOnly: true })).rows.filter((r) => r.Lat != null);
  const surfaceLive = [];
  for (let offset = 0; offset < surface.length; offset += 50) {
    const batch = surface.slice(offset, offset + 50);
    try {
      const out = await askSeries(
        batch.map((station, index) => ({
          ItemId: index,
          Torzsszam: Number(station.Tsz),
          AdatFajtaKod: 71,
          AdatTipusKod: 100,
          StartTime: start,
          EndTime: end,
        })),
        { timeoutMs: 60000 },
      );
      const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
      batch.forEach((station, index) => {
        const items = usable(byItemId.get(index));
        if (!items.length) return;
        if (now - new Date(items[items.length - 1].UTCTime) > 3 * 24 * 3600 * 1000) return;
        surfaceLive.push({ station, samples: items.length, sum: items.reduce((t, i) => t + Number(i.Adat), 0) });
      });
    } catch (err) {
      console.log(`  chunk at ${offset}: FAILED ${err.message}`);
    }
  }
  console.log(`${surfaceLive.length} river gauges also report rainfall.`);
  // Only the Transdanubian ones: that is the question this section exists to answer.
  for (const row of surfaceLive.filter((r) => r.station.Lon < 19).sort((a, b) => a.station.Lon - b.station.Lon)) {
    console.log(
      `  ${String(row.station.Tsz).padEnd(8)} ${String(row.station.Nev).slice(0, 26).padEnd(26)} ` +
        `vizig ${String(row.station.Vizig).padStart(2)}  ${row.station.Lat.toFixed(3)},${row.station.Lon.toFixed(3)}  ` +
        `${String(row.samples).padStart(4)} samples  35d sum ${row.sum.toFixed(1)} mm  [${row.station.MdrNev ?? ''}]`,
    );
  }

  // How far back does the archive go? Without this there is no normal to compare to.
  const probeStation = live.sort((a, b) => b.samples - a.samples)[0];
  if (probeStation) {
    console.log(`\nArchive depth at ${probeStation.station.Nev} (Tsz ${probeStation.station.Tsz}), same weeks in earlier years:`);
    for (const yearsBack of [1, 2, 3, 5, 10, 20]) {
      const from = new Date(now.getTime() - (yearsBack * 365 + 35) * 24 * 3600 * 1000);
      const to = new Date(now.getTime() - yearsBack * 365 * 24 * 3600 * 1000);
      try {
        const out = await askSeries([
          {
            ItemId: 0,
            Torzsszam: Number(probeStation.station.Tsz),
            AdatFajtaKod: 71,
            AdatTipusKod: 100,
            StartTime: from.toISOString(),
            EndTime: to.toISOString(),
          },
        ]);
        const items = usable(Array.isArray(out) ? out[0] : null);
        const sum = items.reduce((total, i) => total + Number(i.Adat), 0);
        console.log(
          `  ${yearsBack} year(s) back (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}): ` +
            `${String(items.length).padStart(4)} samples, ${sum.toFixed(1)} mm`,
        );
      } catch (err) {
        console.log(`  ${yearsBack} year(s) back: FAILED ${err.message}`);
      }
    }
  }
}

/**
 * Every published well, asked what it still reports.
 *
 * The matrix says 69 (talajvízállás) is empty at every well under every data type, and
 * that 70 (rétegvízszint) answers at some. Before concluding that the shallow water table
 * is simply not published here, ask all 524 rather than the twelve that happened to be
 * first in their directorate - a national conclusion drawn from twelve wells is a guess.
 *
 * The distinction matters for what could be built: talajvíz is the shallow table a well
 * in a garden reaches and what a maize root system drinks; rétegvíz is the confined
 * aquifer below it. Labelling one as the other would be the single most misleading thing
 * this project could publish.
 */
const KIND_LABEL = { 68: 'vízállás', 69: 'talajvízállás', 70: 'rétegvízszint', 71: 'csapadék', 81: 'vízhőmérséklet' };

/**
 * Which measuring networks exist at all.
 *
 * This project has learned the same lesson twice and paid for it both times: a quantity
 * that answers nowhere is usually being asked of the wrong NETWORK, not the wrong code.
 * `AdatFajtaKod 69` came back empty across 524 wells and went into the documentation as
 * "talajvíz is not published" - it is published, on vmoType 12, by 2030 stations. Today
 * the in-situ water-quality codes (dissolved oxygen, nitrate, chlorophyll) answered
 * nothing on vmoType 11, and the honest reading of that is "not on this network", not
 * "not measured".
 *
 * The four vmoTypes this project knows about were each found by accident. So this asks
 * the catalogue for a range of them and prints how many stations each returns, which is
 * cheap - one request per type - and turns the next such question from a guess into a
 * lookup.
 */
/**
 * Bakes what each soil-moisture station has actually measured, month by month.
 *
 * Separate from probeWellHistory, which will not do: that one gates on five years and
 * ten, and these stations have ONE. A gate written for a decade-long record would return
 * nothing here and the nothing would look like "no data" rather than "a young network".
 *
 * ---------------------------------------------------------------------------
 * ONE YEAR IS NOT A NORMAL, AND THE DOCUMENT SAYS SO
 * ---------------------------------------------------------------------------
 * Every other history this project bakes covers ten years, and the whole point of those
 * is the word "usually". This cannot say "usually" about anything. What it can say is
 * exactly what this station measured in this calendar month of the one year it has, which
 * makes "drier than 85% of the hours it recorded last August" a true and checkable
 * sentence - and a different, weaker sentence than the river percentiles make.
 *
 * `years` is written into every month for that reason. A consumer that renders a
 * one-year band with the same words as a ten-year band is making a claim the data does
 * not support, and this is the field that stops it.
 *
 * Hourly samples are reduced to DAILY MEANS first, like every other history here: a
 * station reporting hourly would otherwise outweigh one with a gap, and a percentile over
 * raw samples measures reporting cadence as much as it measures soil.
 */
async function probeSoilHistory(args = []) {
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const registry = require('../config/soil-stations.json');
  const KIND = registry.kind;
  console.log(`\n########## soil moisture history (kind ${KIND.adatFajtaKod} / type ${KIND.adatTipusKod}) ##########`);

  const MONTHS_BACK = Number(arg('months')) || 14;
  const stations = registry.stations;
  console.log(`${stations.length} stations, ${MONTHS_BACK} months, one request per month\n`);

  // station id -> calendar month -> [daily means]
  const perMonth = new Map();
  for (const s of stations) perMonth.set(s.id, Array.from({ length: 12 }, () => []));
  // station id -> calendar month -> Set of years the month has data from
  const yearsIn = new Map();
  for (const s of stations) yearsIn.set(s.id, Array.from({ length: 12 }, () => new Set()));

  const now = new Date();
  for (let back = 0; back < MONTHS_BACK; back += 1) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    // Whole stations in one request - 23 of them is one call, and asking per station
    // would be 23 times the traffic for the same answer.
    let out;
    try {
      out = await askSeries(
        stations.map((s, index) => ({
          ItemId: index,
          Torzsszam: Number(s.tsz),
          AdatFajtaKod: KIND.adatFajtaKod,
          AdatTipusKod: KIND.adatTipusKod,
          StartTime: start.toISOString(),
          EndTime: end.toISOString(),
        })),
        { timeoutMs: 90000 },
      );
    } catch (err) {
      console.log(`  ${start.toISOString().slice(0, 7)}: FAILED ${err.message.split('\n')[0].slice(0, 70)}`);
      continue;
    }

    const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
    let reached = 0;
    for (const [index, station] of stations.entries()) {
      const items = usable(byItemId.get(index));
      if (!items.length) continue;
      reached += 1;
      // Daily means, keyed by date, before anything is bucketed by month.
      const byDay = new Map();
      for (const item of items) {
        const t = new Date(item.UTCTime);
        if (Number.isNaN(t.getTime())) continue;
        const day = t.toISOString().slice(0, 10);
        const list = byDay.get(day) || [];
        // `Adat`, not `Ertek`. The first run of this bake read a field that does not
        // exist: every timestamp parsed, so the day and month counts came out perfectly
        // sensible - 276 months, 32 days each - and every percentile, min and max in the
        // document was null. A shape that looks right with no numbers in it is the
        // easiest kind of bad bake to ship, which is why emit() below now refuses to.
        list.push(Number(item.Adat));
        byDay.set(day, list);
      }
      for (const [day, values] of byDay) {
        // A day whose samples are all unreadable is skipped rather than averaged into
        // NaN. Without this the day COUNT still rises, which is how the first bake
        // reported 32 days a month and no numbers.
        const real = values.filter(Number.isFinite);
        if (!real.length) continue;
        const mean = real.reduce((a, b) => a + b, 0) / real.length;
        const month = Number(day.slice(5, 7)) - 1;
        perMonth.get(station.id)[month].push(round2(mean));
        yearsIn.get(station.id)[month].add(day.slice(0, 4));
      }
    }
    console.log(`  ${start.toISOString().slice(0, 7)}: ${reached}/${stations.length} stations answered`);
    await sleep(500);
  }

  const QUANTILES = [5, 25, 50, 75, 95];
  const document = { unit: KIND.unit, quantiles: QUANTILES, stations: {} };
  for (const station of stations) {
    const months = [];
    for (let m = 0; m < 12; m += 1) {
      const values = perMonth.get(station.id)[m].slice().sort((a, b) => a - b);
      // Ten days, not thirty: a month with a fortnight of hourly readings describes that
      // month perfectly well, and demanding a full one throws away the edges of the
      // record - which for a one-year network is a large share of it.
      if (values.length < 10) { months.push(null); continue; }
      months.push({
        // `q`, not `q / 100`. percentileOf takes a PERCENTAGE and divides internally -
        // every other caller in this file passes 5, 25, 50. Passing 0.05 made
        // `(0.05/100) * (n-1)` round to index 0, so all five percentiles came back
        // equal to the minimum: 275 of 276 station-months had p95 - p5 under half a
        // point while their min and max were four points apart.
        p: QUANTILES.map((q) => round2(percentileOf(values, q))),
        min: values[0],
        max: values[values.length - 1],
        days: values.length,
        // ONE, on this network, and the reason this field is not optional. See the header.
        years: yearsIn.get(station.id)[m].size,
      });
    }
    document.stations[station.id] = { name: station.name, months };
  }

  const covered = Object.values(document.stations)
    .filter((s) => s.months.some(Boolean)).length;
  console.log(`\n${covered}/${stations.length} stations have at least one usable month`);

  // Refuses to emit a document whose shape is right and whose numbers are all missing.
  // The first run of this bake produced exactly that - 23 stations, 276 months, sensible
  // day counts, and a null in every percentile - because it read a field name that does
  // not exist. Nothing about the output looked wrong until someone opened it.
  const withNumbers = Object.values(document.stations).filter(
    (s) => (s.months || []).some((m) => m && m.p.every(Number.isFinite)),
  ).length;
  if (!withNumbers) {
    console.log('\nEVERY percentile is missing. Not writing a document that has a shape and no data.');
    return;
  }
  console.log(`${withNumbers}/${stations.length} stations have real percentiles`);

  // And a spread, which is a separate question. The first numeric bake produced five
  // percentiles that were all the minimum, because percentileOf was handed a fraction
  // where it wanted a percentage - a document full of real numbers that described no
  // distribution at all. A band with no width cannot rank anything.
  const months = Object.values(document.stations).flatMap((s) => (s.months || []).filter(Boolean));
  const withSpread = months.filter((m) => m.p[4] > m.p[0]).length;
  console.log(`${withSpread}/${months.length} months have p95 above p5`);
  if (!withSpread) {
    console.log('\nNo month has any spread between its percentiles. Not writing it.');
    return;
  }

  emitDocument('soil-history', document, 'src/config/soil-history.json');
}

async function probeVmoScan(args = []) {
  console.log('\n########## measuring networks (vmoType) ##########');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const from = Number(arg('from')) || 1;
  const to = Number(arg('to')) || 24;
  const out = {};

  for (let vmo = from; vmo <= to; vmo += 1) {
    try {
      const { rows } = await fetchCatalogue(vmo, { internetOnly: true });
      const list = Array.isArray(rows) ? rows : [];
      const withCoords = list.filter((r) => r.Lat != null && r.Lon != null).length;
      out[vmo] = { stations: list.length, withCoords };
      // A name or two, because a count alone does not say what the network IS, and the
      // station names are the only clue the catalogue gives.
      const names = list.slice(0, 3).map((r) => r.Nev || r.Name || r.Tsz).filter(Boolean);
      if (list.length) out[vmo].sample = names;
      console.log(`  vmoType ${String(vmo).padStart(2)}: ${String(list.length).padStart(5)} station(s)` +
        `${list.length ? `   e.g. ${names.join(', ')}` : ''}`);
      if (list.length && !out[vmo].fields) {
        out[vmo].fields = Object.keys(list[0]);
      }
    } catch (err) {
      out[vmo] = { error: err.message.split('\n')[0] };
      console.log(`  vmoType ${String(vmo).padStart(2)}: FAILED ${err.message.split('\n')[0].slice(0, 70)}`);
    }
    await sleep(300);
  }

  emitDocument('vmo-scan', out, 'reference - which station networks exist');
}

async function probeWellScan(args = []) {
  console.log('\n########## well scan ##########');

  // Which network, and which quantities. Defaults are the confined-aquifer wells; the
  // shallow water table lives on a different network entirely (vmoType 12), which is why
  // asking code 69 of vmoType 13 answered nowhere and was recorded as "talajvíz is not
  // published". The code was right and the network was wrong.
  const vmoArg = Number((args.find((a) => a.startsWith('--vmo=')) || '').slice(6)) || 13;
  const kindArg = (args.find((a) => a.startsWith('--kinds=')) || '').slice(8);
  const KINDS = kindArg
    ? kindArg.split(',').map(Number).filter(Number.isFinite).map((k) => [k, KIND_LABEL[k] || String(k)])
    : [[69, 'talajvízállás'], [70, 'rétegvízszint']];

  const { rows } = await fetchCatalogue(vmoArg, { internetOnly: true });
  const usableRows = rows.filter((r) => r.Lat != null && r.Lon != null);
  console.log(`vmoType ${vmoArg}: ${rows.length} published stations, ${usableRows.length} with coordinates`);

  // Every field the catalogue carries for a well, printed once.
  //
  // The first scan came back with values spanning -8156.95 to -2.33, which looked like two
  // different units in one column. The catalogue settles it: each well carries `Npt`, its
  // datum in metres above the Baltic, and the series is a depth against that datum. So a
  // reading is interpretable per well, and `Npt` is what makes it checkable rather than
  // assumed - without it, -8156.95 is either a deep karst well or a broken record and
  // there is no way to tell which.
  if (rows.length) {
    console.log(`\ncatalogue fields: ${Object.keys(rows[0]).join(', ')}`);
    console.log(`sample row: ${JSON.stringify(rows[0])}`);
  }

  const now = new Date();
  const start = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString();
  const end = new Date(now.getTime() + 3600 * 1000).toISOString();

  // The data TYPE, which the first pass never varied. It asked 100 (operatív) only, got
  // almost nothing, and the conclusion recorded was "groundwater is not published" -
  // when the real finding was "groundwater is not operational telemetry". A well read by
  // an observer with a dip meter every week is not a live feed, and would never be filed
  // as one. 100 is kept so the negative result stays reproducible.
  const typeArg = (args.find((a) => a.startsWith('--types=')) || '').slice(8);
  const TYPES = (typeArg ? typeArg.split(',') : ['100', '6', '15', '2', '1'])
    .map(Number).filter(Number.isFinite);
  const TYPE_LABEL = { 100: 'operatív', 5: 'előrejelzett', 6: 'számított', 15: 'becsült' };
  console.log(`data types tried: ${TYPES.join(', ')}`);

  const found = [];

  for (const [haf, label] of KINDS) {
  for (const atk of TYPES) {
    const live = [];
    let answered = 0;

    const CHUNK = 50;
    for (let offset = 0; offset < usableRows.length; offset += CHUNK) {
      const batch = usableRows.slice(offset, offset + CHUNK);
      try {
        const out = await askSeries(
          batch.map((well, index) => ({
            ItemId: index,
            Torzsszam: Number(well.Tsz),
            AdatFajtaKod: haf,
            AdatTipusKod: atk,
            StartTime: start,
            EndTime: end,
          })),
          { timeoutMs: 60000 },
        );
        const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
        batch.forEach((well, index) => {
          const items = usable(byItemId.get(index));
          if (!items.length) return;
          answered += 1;
          const last = new Date(items[items.length - 1].UTCTime);
          // Everything that answered at all, with its age, rather than a pass/fail at
          // seven days. A groundwater network is not telemetry: much of it is an observer
          // with a dip meter on a weekly or fortnightly round, so a seven-day cut silently
          // discards wells that are working exactly as intended. The age is recorded and
          // the cut is made later, where it can be seen.
          live.push({
            well,
            samples: items.length,
            last: items[items.length - 1],
            ageDays: Math.round((now - last) / 86400000),
          });
        });
      } catch (err) {
        console.log(`  chunk at ${offset}: FAILED ${err.message}`);
      }
    }

    const tag = `${haf}/${atk}`;
    const within = (d) => live.filter((r) => r.ageDays <= d).length;
    console.log(
      `  ${tag.padEnd(8)} ${String(label).padEnd(14)} ${String(TYPE_LABEL[atk] || atk).padEnd(12)} ` +
        `answered ${String(answered).padStart(4)}  ` +
        `within 7d ${String(within(7)).padStart(4)}  14d ${String(within(14)).padStart(4)}  ` +
        `30d ${String(within(30)).padStart(4)}`,
    );
    // The full list, not a sample. The previous pass kept the first twenty for the emitted
    // document, which is fine for reading a log and useless for building a registry: it
    // would have silently capped a 160-well network at 20 and nothing downstream would
    // have shown that anything was missing. The console print is still capped, because
    // that is a different job.
    if (answered > 0) found.push({ haf, atk, label, answered, live });
  }
  }

  console.log('\n===== combinations that returned anything =====');
  if (!found.length) {
    console.log('  none. Groundwater is genuinely not served by this API on any of these pairs.');
    return;
  }
  for (const f of found) {
    console.log(`\n--- AdatFajtaKod ${f.haf} (${f.label}) x AdatTipusKod ${f.atk}: ` +
      `${f.answered} wells answered inside 60 days ---`);
    for (const row of [...f.live].sort((a, b) => b.samples - a.samples).slice(0, 20)) {
      console.log(
        `  ${String(row.well.Tsz).padEnd(8)} ${String(row.well.Nev).slice(0, 26).padEnd(26)} ` +
          `vizig ${String(row.well.Vizig).padStart(2)}  ${row.well.Lat.toFixed(3)},${row.well.Lon.toFixed(3)}  ` +
          `npt ${String(row.well.Npt).padStart(7)}  ` +
          `${String(row.samples).padStart(4)} samples  last ${row.last.UTCTime.slice(0, 16)} = ${row.last.Adat}`,
      );
    }

    // How many directorates this actually covers.
    //
    // 48 wells sounds national and is not: the first pass was two thirds Budapest. A
    // groundwater map that is really a map of the Buda hills has to say so, and the only
    // way to know is to count before building anything on it.
    const byVizig = new Map();
    for (const row of f.live) byVizig.set(row.well.Vizig, (byVizig.get(row.well.Vizig) || 0) + 1);
    console.log(`  directorates: ${[...byVizig.entries()].sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v}:${n}`).join(' ')}`);

    // What the values look like against their own datum, in metres above the Baltic.
    // A raw column running -8157 to +8.6 is uninterpretable; the same column plus each
    // well's Npt is an elevation, and an elevation can be sanity-checked against the
    // terrain it sits under.
    const rows2 = f.live
      .map((r) => ({ v: Number(r.last.Adat), npt: Number(r.well.Npt), name: r.well.Nev }))
      .filter((r) => Number.isFinite(r.v));
    const values = rows2.map((r) => r.v).sort((a, b) => a - b);
    if (values.length) {
      const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
      console.log(`  raw:     min ${values[0]}  p25 ${at(0.25)}  median ${at(0.5)}  p75 ${at(0.75)}  max ${values[values.length - 1]}`);
      for (const [div, unit] of [[100, 'cm'], [1, 'm']]) {
        const abs = rows2.filter((r) => Number.isFinite(r.npt)).map((r) => r.npt + r.v / div).sort((a, b) => a - b);
        if (!abs.length) continue;
        const a = (q) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))];
        console.log(`  npt+v/${String(div).padEnd(3)} (${unit}): min ${a(0).toFixed(1)}  median ${a(0.5).toFixed(1)}  max ${abs[abs.length - 1].toFixed(1)} mBf`);
      }
    }
  }
  // The whole point of the scan: a machine-readable list of wells worth registering.
  //
  // Npt travels with every well. It is the datum the reading is measured against, so
  // without it the number in the registry is a quantity with no origin - and the one
  // check that can catch a broken well (does datum plus depth land somewhere plausible
  // under the terrain) becomes impossible after the fact.
  emitDocument(`well-scan-${vmoArg}`, found.map((f) => ({
    adatFajtaKod: f.haf, adatTipusKod: f.atk, answered: f.answered,
    wells: f.live.map((r) => ({ tsz: r.well.Tsz, name: r.well.Nev, vizig: r.well.Vizig,
      lat: r.well.Lat, lon: r.well.Lon, npt: r.well.Npt, telepules: r.well.Telepules,
      uzem: r.well.Uzem, samples: r.samples, last: r.last.UTCTime, ageDays: r.ageDays,
      value: r.last.Adat })),
  })), 'src/config/wells.json (after review)');
}

/**
 * Compute each registered gauge's monthly normals from its own ten-year archive.
 *
 * Prints a JSON document to paste into src/config/rain-normals.json. Baked rather than
 * fetched live for the same reason the stage thresholds are: it is ten requests per
 * gauge, it changes once a year at most, and a poll that needs 470 extra requests to
 * answer "is this a lot of rain" would be paying for the answer every fifteen minutes.
 *
 * A month counts only if most of its days reported. Otherwise a gauge that went offline
 * for three weeks of a July contributes a near-zero July to its own normal, which then
 * makes the next dry July look average - the exact failure that would make this feature
 * worse than not having it.
 */
async function probeRainNormals() {
  console.log('\n########## rainfall normals ##########');
  const { listRainGauges } = require('../config/rain-gauges');
  const gauges = listRainGauges();
  const YEARS = 10;
  const now = new Date();

  console.log(`${gauges.length} gauges, ${YEARS} years each\n`);
  const out = {};

  for (const gauge of gauges) {
    // [month][year] -> {sum, samples}
    const buckets = Array.from({ length: 12 }, () => []);
    let failures = 0;

    for (let back = 1; back <= YEARS; back += 1) {
      const from = new Date(Date.UTC(now.getUTCFullYear() - back, 0, 1));
      const to = new Date(Date.UTC(now.getUTCFullYear() - back + 1, 0, 1));
      try {
        const rows = await askSeries(
          [
            {
              ItemId: 0,
              Torzsszam: Number(gauge.tsz),
              AdatFajtaKod: 71,
              AdatTipusKod: 100,
              StartTime: from.toISOString(),
              EndTime: to.toISOString(),
            },
          ],
          { timeoutMs: 90000 },
        );
        const items = usable(Array.isArray(rows) ? rows[0] : null);
        const perMonth = Array.from({ length: 12 }, () => ({ sum: 0, samples: 0, days: new Set() }));
        for (const item of items) {
          const mm = Number(item.Adat);
          // The same filter the live adapter applies. Without it Sándorfalva's February
          // carried a -443 mm sample - a sensor reset or a correction, not rain - which
          // summed straight through into a normal of 31 mm for the whole year.
          if (!Number.isFinite(mm) || mm < 0) continue;
          const when = new Date(item.UTCTime);
          const bucket = perMonth[when.getUTCMonth()];
          bucket.sum += mm;
          bucket.samples += 1;
          bucket.days.add(when.toISOString().slice(0, 10));
        }
        perMonth.forEach((bucket, month) => {
          // Most of the month has to have reported. Distinct days rather than samples,
          // because cadence varies from four a day to one.
          if (bucket.days.size < 24) return;
          // Hungary's wettest recorded month at a single gauge is around 250 mm. Past
          // 400 the value is an artefact, and one artefact year poisons the normal that
          // every later comparison is made against.
          if (bucket.sum > 400) return;
          buckets[month].push(bucket.sum);
        });
      } catch (err) {
        failures += 1;
        if (failures === 1) console.log(`  ${gauge.id}: ${err.message}`);
      }
    }

    const mm = buckets.map((values) =>
      values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null,
    );
    const covered = buckets.filter((values) => values.length).length;
    const years = Math.max(...buckets.map((values) => values.length), 0);

    out[gauge.id] = { mm, years, months: covered };
    console.log(
      `  ${gauge.id.padEnd(18)} months ${String(covered).padStart(2)}/12  up to ${years} yr  ` +
        `annual ${mm.every((v) => v !== null) ? mm.reduce((a, b) => a + b, 0).toFixed(0) : '?'} mm  ` +
        `[${mm.map((v) => (v === null ? '-' : v.toFixed(0))).join(' ')}]`,
    );
  }

  const complete = Object.values(out).filter((entry) => entry.months === 12).length;
  console.log(`\n${complete} of ${gauges.length} gauges have all twelve months.`);
  // One line, deliberately: the log is read back through an API that returns whole
  // trailing chunks, and a pretty-printed document turns 47 gauges into 900 lines.
  console.log('\n----- paste into src/config/rain-normals.json -----');
  console.log(JSON.stringify(out));
}

/**
 * Ten years of discharge per station, reduced to a monthly distribution.
 *
 * The site can currently say "411 m3/s, 73% of the long-term mean". That is a true
 * sentence nobody can act on: it does not say whether 73% is a normal August or the
 * worst in a decade, and those are different stories. A mean cannot answer it - only a
 * distribution can. What comes out of here lets the page say "lower than any August day
 * since 2017", which is the sentence a reader actually understands.
 *
 * Bucketed by calendar month, not by day-of-year window. A month is how hydrology talks
 * about this ("augusztusi kisviz"), it is what a reader hears, and 12 buckets bake into
 * a file the size of the rain normals while 365 windows do not. The cost is a seam at
 * each month boundary: on 31 August the comparison set includes 1 August, which in a
 * receding summer is a wetter day. That is a real limitation and it is reported rather
 * than smoothed away.
 *
 * Daily MEANS, not raw samples. The cadence varies between gauges and across years, so
 * percentiles over raw samples would weight a 15-minute gauge sixteen times more than an
 * hourly one - within the same station, across years, silently.
 *
 * Run it in chunks if the runner is slow: --only=tisza-szeged,duna-mohacs
 */
async function probeFlowHistory(args = []) {
  console.log('\n########## discharge history ##########');
  const { mappedStations, EXTERNAL_IDS } = require('../sources/vizugy');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const YEARS = Number(arg('years')) || 10;
  const only = arg('only');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const stations = mappedStations().filter((s) => !wanted || wanted.has(s.id));
  const now = new Date();

  // A month-year contributes only if most of it reported. A February with three days in
  // it does not describe February, and its lowest day would be published as "the lowest
  // February day in ten years" - the same failure the rain normals guard against.
  const MIN_DAYS_IN_MONTH = 20;
  // Below this many years the phrase "in N years" is not worth saying, so the domain is
  // given the count and left to refuse.
  const MIN_YEARS = 5;

  console.log(`${stations.length} stations, ${YEARS} years each (${stations.length * YEARS} requests)\n`);
  const out = {};
  // Second document from the same fetch: per station, per year, the median of each
  // calendar month. 29 x 10 x 12 numbers, which is nothing, and it answers a question
  // the percentiles cannot - "the last time August was this low, what did September
  // do". That is not a forecast, it is what happened before from here, and it is the
  // only forward-looking sentence this project can make honestly.
  const yearly = {};

  for (const station of stations) {
    const external = EXTERNAL_IDS[station.id];
    // [month] -> array of daily means across all years
    const perMonth = Array.from({ length: 12 }, () => []);
    // [month] -> {value, year} of the lowest and highest day seen
    const extremes = Array.from({ length: 12 }, () => ({ min: null, max: null }));
    const yearsIn = Array.from({ length: 12 }, () => new Set());
    let failures = 0;

    for (let back = 1; back <= YEARS; back += 1) {
      const year = now.getUTCFullYear() - back;
      const from = new Date(Date.UTC(year, 0, 1));
      const to = new Date(Date.UTC(year + 1, 0, 1));
      try {
        const rows = await askSeries(
          [
            {
              ItemId: 0,
              Torzsszam: Number(external),
              AdatFajtaKod: 87,
              AdatTipusKod: 100,
              StartTime: from.toISOString(),
              EndTime: to.toISOString(),
            },
          ],
          { timeoutMs: 120000 },
        );

        // day -> {sum, n}, then the mean. Sub-daily cadence varies by gauge and by year.
        const byDay = new Map();
        for (const item of usable(Array.isArray(rows) ? rows[0] : null)) {
          const q = Number(item.Adat);
          // A negative discharge at these sections is an instrument fault or a sign
          // convention, not backflow. Letting one through would set a 10-year minimum
          // that every later reading is measured against.
          if (!Number.isFinite(q) || q < 0) continue;
          const day = item.UTCTime.slice(0, 10);
          const bucket = byDay.get(day) || { sum: 0, n: 0 };
          bucket.sum += q;
          bucket.n += 1;
          byDay.set(day, bucket);
        }

        const daysInMonth = Array.from({ length: 12 }, () => 0);
        for (const day of byDay.keys()) {
          daysInMonth[Number(day.slice(5, 7)) - 1] += 1;
        }
        // Daily means of THIS year alone, so the year's own monthly medians can be
        // taken below. Separate from perMonth, which pools every year together.
        const thisYear = Array.from({ length: 12 }, () => []);

        for (const [day, bucket] of byDay) {
          const month = Number(day.slice(5, 7)) - 1;
          if (daysInMonth[month] < MIN_DAYS_IN_MONTH) continue;
          const mean = bucket.sum / bucket.n;
          perMonth[month].push(mean);
          thisYear[month].push(mean);
          yearsIn[month].add(year);
          const ex = extremes[month];
          if (ex.min === null || mean < ex.min.value) ex.min = { value: round2(mean), year, day };
          if (ex.max === null || mean > ex.max.value) ex.max = { value: round2(mean), year, day };
        }

        const yearMonths = thisYear.map((values) => {
          if (!values.length) return null;
          return round2(percentileOf(values.slice().sort((a, b) => a - b), 50));
        });
        if (yearMonths.some((v) => v !== null)) {
          (yearly[station.id] = yearly[station.id] || {})[year] = yearMonths;
        }
      } catch (err) {
        failures += 1;
        if (failures === 1) console.log(`  ${station.id}: ${err.message}`);
      }
    }

    const months = perMonth.map((values, month) => {
      const years = yearsIn[month].size;
      if (!values.length || years < MIN_YEARS) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        p: [5, 10, 25, 50, 75, 90, 95].map((q) => round2(percentileOf(sorted, q))),
        min: extremes[month].min,
        max: extremes[month].max,
        days: values.length,
        years,
      };
    });

    const covered = months.filter(Boolean).length;
    out[station.id] = { months, unit: 'm3s' };
    console.log(
      `  ${station.id.padEnd(24)} months ${String(covered).padStart(2)}/12  ` +
        `median [${months.map((m) => (m ? m.p[3].toFixed(0) : '-')).join(' ')}]`,
    );
    // Checkpoint every station. This run is 300 requests against someone else's service;
    // if it times out at station 22 the artifact should still carry 22 stations rather
    // than nothing, because the alternative is asking for all 300 again.
    writeDocument('flow-history', out);
    writeDocument('flow-yearly', yearly);
  }

  const complete = Object.values(out).filter((e) => e.months.every(Boolean)).length;
  console.log(`\n${complete} of ${stations.length} stations have all twelve months.`);
  console.log(`percentiles are [5 10 25 50 75 90 95] of daily mean discharge, m3/s`);
  emitDocument('flow-history', out, 'src/config/flow-history.json');

  const yearCount = Object.values(yearly).reduce((n, y) => n + Object.keys(y).length, 0);
  console.log(`\n${Object.keys(yearly).length} stations x ${yearCount} station-years of monthly medians`);
  emitDocument('flow-yearly', yearly, 'src/config/flow-yearly.json');
}

/**
 * Hand a baked document back to whoever ran the probe.
 *
 * The log has always been the delivery mechanism, and for the rain normals at 5 KB it
 * was fine. This document is closer to 40 KB on a single line - inside a log that is
 * read back through an API returning trailing chunks, which is a good way to lose the
 * front of it. So it also goes to a file when PROBE_OUT_DIR is set, which the workflow
 * uploads as an artifact. The log copy stays for a run from a laptop, where there is no
 * artifact to download.
 */
/**
 * The log ceiling for a pasted document.
 *
 * Everything baked so far has been tens of kilobytes - percentiles, station lists - and
 * printing it whole is how a result gets out of a runner without anyone downloading an
 * artifact. Geometry is not like that: a national hydrography layer is megabytes, and
 * pasting it would flood the log, blow past what the API will return, and bury the
 * summary lines that say what was actually found. Past this size the document goes to
 * the artifact and the commit only.
 */
const LOG_PASTE_LIMIT = 400000;

function emitDocument(name, doc, destination) {
  const file = writeDocument(name, doc);
  const json = JSON.stringify(doc);
  if (file) console.log(`\nwrote ${file} (${json.length} bytes) - download it from the run's artifacts`);
  if (json.length > LOG_PASTE_LIMIT) {
    console.log(`\n----- ${name} is ${json.length} bytes, too large to paste -----`);
    console.log(`Destination: ${destination}. Take it from the committed probe-output/ copy or the artifact.`);
    return;
  }
  // One line, deliberately: pretty-printing turns 30 stations into two thousand.
  console.log(`\n----- paste into ${destination} -----`);
  console.log(json);
}

/**
 * A response too big to commit, kept for the artifact only.
 *
 * `probe-out/*.json` is what the workflow copies into probe-output/ and commits, and the
 * glob does not recurse - so a subdirectory is the difference between evidence a reviewer
 * reads in a diff and a fifty-megabyte blob nobody wanted in the history. Raw upstream
 * responses go here; the reduced document a human might promote goes alongside.
 */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** Deliberate pacing between requests to someone else's service. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeRaw(name, text) {
  const dir = process.env.PROBE_OUT_DIR;
  if (!dir) return null;
  const fs = require('node:fs');
  const path = require('node:path');
  const sub = path.join(dir, 'raw');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${name}.json`);
  fs.writeFileSync(file, text);
  return file;
}

/** The file half of emitDocument, callable mid-run as a checkpoint. Returns the path. */
function writeDocument(name, doc) {
  const dir = process.env.PROBE_OUT_DIR;
  if (!dir) return null;
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

/**
 * The same ten-year monthly distribution, for lake LEVEL rather than river discharge.
 *
 * Separate from probeFlowHistory because the quantity is different in every way that
 * matters: centimetres on a gauge datum rather than m3/s, AdatFajtaKod 68 rather than 87,
 * and four lakes rather than twenty-nine. Sharing the loop would mean a flag deciding
 * which of two unit systems every line meant.
 *
 * The reason to bake it: the Balaton has a REGULATED seasonal target level - held high
 * through the summer for boating, drawn down before winter - so "12 cm below the
 * long-term average" is a different statement in April than in October, and the annual
 * mean cannot tell those apart. Same failure as the rivers, on a lake whose level is a
 * standing news story.
 */
async function probeLakeHistory(args = []) {
  console.log('\n########## lake level history ##########');
  const { LAKES } = require('../config/lakes');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const YEARS = Number(arg('years')) || 10;
  const now = new Date();
  const MIN_DAYS_IN_MONTH = 20;
  const MIN_YEARS = 5;

  console.log(`${LAKES.length} lakes, ${YEARS} years each (${LAKES.length * YEARS} requests)\n`);
  const out = {};
  // Per-year monthly medians alongside the pooled percentiles, same shape as
  // flow-yearly.json. The pooled document answers "is this low for August"; it cannot
  // answer "the last time it was this low in August, how long until it came back",
  // because pooling deliberately throws away which year each reading belonged to. The
  // refill question needs the years kept apart, so they are baked apart.
  const yearly = {};

  for (const lake of LAKES) {
    const perMonth = Array.from({ length: 12 }, () => []);
    const extremes = Array.from({ length: 12 }, () => ({ min: null, max: null }));
    const yearsIn = Array.from({ length: 12 }, () => new Set());
    let failures = 0;

    for (let back = 1; back <= YEARS; back += 1) {
      const year = now.getUTCFullYear() - back;
      try {
        const rows = await askSeries(
          [
            {
              ItemId: 0,
              Torzsszam: Number(lake.gaugeTsz),
              AdatFajtaKod: 68,
              AdatTipusKod: 100,
              StartTime: new Date(Date.UTC(year, 0, 1)).toISOString(),
              EndTime: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
            },
          ],
          { timeoutMs: 120000 },
        );

        const byDay = new Map();
        for (const item of usable(Array.isArray(rows) ? rows[0] : null)) {
          const cm = Number(item.Adat);
          // No sign filter here, unlike discharge: a lake level is measured against a
          // gauge datum and CAN legitimately be negative. Dropping negatives would cut
          // the low end off exactly the distribution a drought story needs.
          if (!Number.isFinite(cm)) continue;
          const day = item.UTCTime.slice(0, 10);
          const bucket = byDay.get(day) || { sum: 0, n: 0 };
          bucket.sum += cm;
          bucket.n += 1;
          byDay.set(day, bucket);
        }

        const daysInMonth = Array.from({ length: 12 }, () => 0);
        for (const day of byDay.keys()) daysInMonth[Number(day.slice(5, 7)) - 1] += 1;

        const thisYear = Array.from({ length: 12 }, () => []);

        for (const [day, bucket] of byDay) {
          const month = Number(day.slice(5, 7)) - 1;
          if (daysInMonth[month] < MIN_DAYS_IN_MONTH) continue;
          const mean = bucket.sum / bucket.n;
          perMonth[month].push(mean);
          thisYear[month].push(mean);
          yearsIn[month].add(year);
          const ex = extremes[month];
          if (ex.min === null || mean < ex.min.value) ex.min = { value: round2(mean), year, day };
          if (ex.max === null || mean > ex.max.value) ex.max = { value: round2(mean), year, day };
        }

        const yearMonths = thisYear.map((values) =>
          values.length ? round2(percentileOf(values.slice().sort((a, b) => a - b), 50)) : null,
        );
        if (yearMonths.some((v) => v !== null)) {
          (yearly[lake.id] = yearly[lake.id] || {})[year] = yearMonths;
        }
      } catch (err) {
        failures += 1;
        if (failures === 1) console.log(`  ${lake.id}: ${err.message}`);
      }
    }

    const months = perMonth.map((values, month) => {
      const years = yearsIn[month].size;
      if (!values.length || years < MIN_YEARS) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        p: [5, 10, 25, 50, 75, 90, 95].map((q) => round2(percentileOf(sorted, q))),
        min: extremes[month].min,
        max: extremes[month].max,
        days: values.length,
        years,
      };
    });

    const covered = months.filter(Boolean).length;
    out[lake.id] = { months, unit: 'cm' };
    console.log(
      `  ${lake.id.padEnd(16)} months ${String(covered).padStart(2)}/12  ` +
        `median [${months.map((m) => (m ? m.p[3].toFixed(0) : '-')).join(' ')}]`,
    );
    writeDocument('lake-history', out);
    writeDocument('lake-yearly', yearly);
  }

  console.log('\npercentiles are [5 10 25 50 75 90 95] of daily mean level, cm on the gauge datum');
  const yearCount = Object.values(yearly).reduce((n, y) => n + Object.keys(y).length, 0);
  console.log(`${Object.keys(yearly).length} lakes x ${yearCount} lake-years of monthly medians`);
  emitDocument('lake-history', out, 'src/config/lake-history.json');
  emitDocument('lake-yearly', yearly, 'src/config/lake-yearly.json');
}

/**
 * Ten years of each registered well, as a distribution per calendar month.
 *
 * WHY A WELL CANNOT BE PUBLISHED AS A NUMBER, AND WHAT IS PUBLISHED INSTEAD
 *
 * The series is a depth against that well's own datum. Read across the network it spans
 * -8157 to +8.6, because a karst well under the Buda hills sits eighty metres down and a
 * well beside the Tisza sits at the surface - both correct, neither comparable. There is
 * no national groundwater number to be had from this, and averaging one would be a
 * fabrication dressed as a statistic.
 *
 * What IS comparable is a well against its own past. "Eighty centimetres below where this
 * well normally stands in August" is a true and useful sentence whatever its datum, and
 * ten wells all saying it at once is a regional signal. So the same ranking machinery the
 * rivers and lakes use is pointed at each well's own record, and the raw depth is carried
 * along for anyone who wants it rather than being the headline.
 *
 * Cheap compared to the flow bake: a well reports a handful of times a day rather than
 * every fifteen minutes, so a whole year for forty wells fits in one request.
 */
async function probeWellHistory(args = []) {
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  // Two networks, one bake. The shallow water table (vmoType 12, code 69) and the
  // confined aquifer (vmoType 13, code 70) need identical arithmetic and must never share
  // an output file: they are different water, in different units, pointing in opposite
  // directions, and a single document keyed by station id would silently let one be
  // ranked against the other's record.
  const network = arg('network') === 'shallow' ? 'shallow' : 'deep';
  const isShallow = network === 'shallow';
  const registry = isShallow ? require('../config/shallow-wells.json') : require('../config/wells').listWells();
  const WELL_KIND = isShallow
    ? { adatFajtaKod: 69, adatTipusKod: 100, label: 'talajvízállás' }
    : require('../config/wells').WELL_KIND;
  const OUTPUT = isShallow ? 'shallow-history' : 'well-history';

  console.log(`\n########## ${isShallow ? 'shallow water table' : 'groundwater'} history ` +
    `(kind ${WELL_KIND.adatFajtaKod} / type ${WELL_KIND.adatTipusKod}) ##########`);

  const only = (arg('only') || '').split(',').filter(Boolean);
  const wells = registry.filter((w) => !only.length || only.includes(w.id));
  const YEARS = Number(arg('years')) || 10;
  const CHUNK = 40;
  const now = new Date();
  // Lower than the rivers' 20: a well read twice a day still misses days, and a month
  // with fifteen readings is a perfectly good month for something that moves this slowly.
  const MIN_DAYS_IN_MONTH = 10;
  const MIN_YEARS = 5;

  const chunks = Math.ceil(wells.length / CHUNK);
  console.log(`${wells.length} wells, ${YEARS} years, ${chunks} per year = ${chunks * YEARS} requests\n`);

  // well id -> every daily mean it ever reported, kept flat until the whole decade is in.
  //
  // Flat rather than bucketed straight into months, because the decision that has to be
  // made first is which values are the same measurement at all - and that can only be
  // made against the well's whole record, not one month of it.
  const daily = new Map();
  const perMonth = new Map();
  const extremes = new Map();
  const yearsIn = new Map();
  for (const well of wells) {
    daily.set(well.id, []);
    perMonth.set(well.id, Array.from({ length: 12 }, () => []));
    extremes.set(well.id, Array.from({ length: 12 }, () => ({ min: null, max: null })));
    yearsIn.set(well.id, Array.from({ length: 12 }, () => new Set()));
  }

  for (let back = 1; back <= YEARS; back += 1) {
    const year = now.getUTCFullYear() - back;
    let reached = 0;

    for (let offset = 0; offset < wells.length; offset += CHUNK) {
      const batch = wells.slice(offset, offset + CHUNK);
      try {
        const out = await askSeries(
          batch.map((well, index) => ({
            ItemId: index,
            Torzsszam: Number(well.tsz),
            AdatFajtaKod: WELL_KIND.adatFajtaKod,
            AdatTipusKod: WELL_KIND.adatTipusKod,
            StartTime: new Date(Date.UTC(year, 0, 1)).toISOString(),
            EndTime: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
          })),
          { timeoutMs: 120000 },
        );
        const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);

        batch.forEach((well, index) => {
          const items = usable(byItemId.get(index));
          if (!items.length) return;
          reached += 1;

          const byDay = new Map();
          for (const item of items) {
            const value = Number(item.Adat);
            // No sign filter, and no plausibility filter either. A depth below a datum is
            // negative nearly everywhere and positive where the water stands above it,
            // and the extremes are the whole point of keeping a record.
            if (!Number.isFinite(value)) continue;
            const day = item.UTCTime.slice(0, 10);
            const bucket = byDay.get(day) || { sum: 0, n: 0 };
            bucket.sum += value;
            bucket.n += 1;
            byDay.set(day, bucket);
          }

          const daysInMonth = Array.from({ length: 12 }, () => 0);
          for (const day of byDay.keys()) daysInMonth[Number(day.slice(5, 7)) - 1] += 1;

          for (const [day, bucket] of byDay) {
            const month = Number(day.slice(5, 7)) - 1;
            if (daysInMonth[month] < MIN_DAYS_IN_MONTH) continue;
            daily.get(well.id).push({ day, month, year, mean: bucket.sum / bucket.n });
          }
        });
      } catch (err) {
        console.log(`  ${year} wells ${offset}-${offset + batch.length}: FAILED ${err.message.split('\n')[0]}`);
      }
    }
    console.log(`  ${year}: ${reached}/${wells.length} wells returned something`);
  }

  // Throw out the days that are not the same measurement as the rest of the well.
  //
  // Eleven of these wells have an archive whose own ten-year span is larger than its
  // median by a factor of a hundred - Budakeszi-1 sits at -76 all decade and carries a
  // single +7560, Zsámbék-14 at -177 with a span of 17961. That is the same convention
  // change that separates the live feed from the archive, except here it is INSIDE the
  // archive, and it does two kinds of damage at once: it drags the percentiles and the
  // recorded maximum somewhere absurd, and it inflates the range so far that the
  // commensurability check downstream can never fire again. A contaminated record does
  // not merely produce a wrong answer, it disables the thing that would have caught it.
  //
  // The test is order of magnitude, not hydrology. Ten times the median magnitude is far
  // outside anything a water table does in a decade and far inside a hundredfold unit
  // change, so a genuine record low survives and a stray convention does not. Dropped
  // counts are printed rather than swallowed: if a well starts shedding half its record,
  // that is the upstream changing and it should be visible.
  const OUTLIER_FACTOR = 10;
  const dropped = new Map();
  for (const well of wells) {
    const rows = daily.get(well.id);
    if (!rows.length) continue;
    const centre = median(rows.map((r) => r.mean));
    const allowed = OUTLIER_FACTOR * Math.max(Math.abs(centre), 1);
    const kept = rows.filter((r) => Math.abs(r.mean - centre) <= allowed);
    dropped.set(well.id, rows.length - kept.length);

    for (const row of kept) {
      perMonth.get(well.id)[row.month].push(row.mean);
      yearsIn.get(well.id)[row.month].add(row.year);
      const ex = extremes.get(well.id)[row.month];
      if (ex.min === null || row.mean < ex.min.value) ex.min = { value: round2(row.mean), year: row.year, day: row.day };
      if (ex.max === null || row.mean > ex.max.value) ex.max = { value: round2(row.mean), year: row.year, day: row.day };
    }
  }
  const contaminated = [...dropped.entries()].filter(([, n]) => n > 0);
  console.log(`\n${contaminated.length} wells had days in a different convention from their own record:`);
  for (const [id, n] of contaminated.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(26)} ${String(n).padStart(4)} of ${String(daily.get(id).length).padStart(5)} days dropped`);
  }

  const out = {};
  for (const well of wells) {
    const months = perMonth.get(well.id).map((values, month) => {
      const years = yearsIn.get(well.id)[month].size;
      if (!values.length || years < MIN_YEARS) return null;
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        p: [5, 10, 25, 50, 75, 90, 95].map((q) => round2(percentileOf(sorted, q))),
        min: extremes.get(well.id)[month].min,
        max: extremes.get(well.id)[month].max,
        days: values.length,
        years,
      };
    });
    const covered = months.filter(Boolean).length;

    // Which direction is "wetter", decided from the well's own decade.
    //
    // Nearly every well reports a NEGATIVE depth below its datum, so a larger number is
    // a higher water table. A handful - all in the Miskolc directorate - report a
    // POSITIVE depth, where a larger number means DEEPER water and every verdict would
    // come out backwards. Ranking those alongside the rest would not fail loudly; it
    // would publish "unusually wet" during a drought.
    //
    // The two groups are separated by two orders of magnitude, not by a hairline: the
    // positive-convention wells sit at 754 and above, and the only other wells that ever
    // read positive are three artesian ones standing 2 to 9 above their datum. Anything
    // in the empty gap between them would do; 100 is the round number in it.
    //
    // Excluded rather than flipped. Flipping would also require knowing the unit, and
    // five wells out of 106 are not worth a second inference stacked on the first.
    const medians = months.filter(Boolean).map((m) => m.p[3]);
    const typical = medians.length ? medians.slice().sort((a, b) => a - b)[Math.floor(medians.length / 2)] : null;
    const rankable = typical !== null && typical < 100;

    if (covered) {
      out[well.id] = {
        months,
        // Deliberately not 'cm' or 'm'. The unit differs between wells and this document
        // never claims to know it; every consumer is expected to rank rather than print.
        unit: 'raw',
        rankable,
        ...(rankable ? {} : {
          note: 'Positive-downward depth convention: larger means deeper. Not ranked alongside the rest.',
        }),
      };
    }
    console.log(
      `  ${well.id.padEnd(26)} months ${String(covered).padStart(2)}/12  ` +
        `${rankable ? '     ' : ' SKIP'}  ` +
        `median [${months.map((m) => (m ? m.p[3].toFixed(0) : '-')).join(' ')}]`,
    );
    writeDocument(OUTPUT, out);
  }

  const rankable = Object.values(out).filter((e) => e.rankable).length;
  console.log(`\n${Object.keys(out).length}/${wells.length} wells have a usable record, ${rankable} of them rankable`);

  // WHICH WAY IS DRY?
  //
  // Everything else on this site reads "bigger number, more water". A depth below a datum
  // reads the other way, and nothing in the numbers announces which one this is. Getting
  // it backwards would not fail - it would publish "unusually wet" through a drought,
  // which is the single worst thing this page could do.
  //
  // The seasons settle it, because they are the one thing about groundwater that is not
  // in doubt: the table is highest after the spring melt and lowest at the end of summer.
  // So if the late-summer median sits ABOVE the spring median, the number is a depth and
  // bigger means drier. This is a measurement, not an assumption, and it is printed so
  // the next person can check it rather than trust it.
  const seasonal = { spring: [], lateSummer: [] };
  for (const entry of Object.values(out)) {
    const at = (m) => (entry.months[m] ? entry.months[m].p[3] : null);
    const spring = [at(2), at(3)].filter(Number.isFinite);   // March, April
    const late = [at(7), at(8)].filter(Number.isFinite);     // August, September
    if (spring.length && late.length) {
      seasonal.spring.push(spring.reduce((a, b) => a + b, 0) / spring.length);
      seasonal.lateSummer.push(late.reduce((a, b) => a + b, 0) / late.length);
    }
  }
  if (seasonal.spring.length) {
    const springMedian = median(seasonal.spring);
    const lateMedian = median(seasonal.lateSummer);
    const deeperInSummer = lateMedian > springMedian;
    console.log(
      `\nseasonal check over ${seasonal.spring.length} stations: ` +
        `spring median ${springMedian.toFixed(1)}, late-summer median ${lateMedian.toFixed(1)}`,
    );
    console.log(
      deeperInSummer
        ? '  late summer reads HIGHER -> the number is a DEPTH: bigger means deeper means drier'
        : '  late summer reads LOWER -> the number is a LEVEL: bigger means more water',
    );
    out.__orientation = {
      biggerMeans: deeperInSummer ? 'drier' : 'wetter',
      springMedian: round2(springMedian),
      lateSummerMedian: round2(lateMedian),
      stations: seasonal.spring.length,
      note:
        'Decided from the seasonal shape rather than assumed: the water table is highest ' +
        'after the spring melt and lowest at the end of summer, so whichever way that ' +
        'ordering runs tells you what the number is.',
    };
  }
  console.log('percentiles are [5 10 25 50 75 90 95] of daily mean depth against each well\'s own datum,');
  console.log('in whatever unit that well reports - which is why nothing here may be averaged across wells');
  emitDocument(OUTPUT, out, `src/config/${OUTPUT}.json`);
}

/**
 * The middle value, used as a robust centre.
 *
 * Robust is the operative word: the whole point of the caller is to find values that are
 * a hundred times off, and a mean would be dragged there by the very outliers it is
 * meant to be measuring against.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear-interpolated percentile of an ascending array - the same rule numpy defaults to. */
function percentileOf(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = ((q / 100) * (sorted.length - 1));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

/**
 * Which (kind, type) pairs a station actually publishes.
 *
 * AdatFajtaKod 69 is "talajvízállás" and every well in vmoType 13 is a groundwater well,
 * and yet asking 69 under AdatTipusKod 100 returned an empty series at all twelve wells
 * sampled - while 70 answered at four of them. So either groundwater is filed under a
 * different data type (100 is `operatív`, and a well read by an observer with a dip meter
 * is not an operational telemetry feed), or under a different kind code entirely.
 *
 * One POST per pair rather than one big one: an unsupported combination fails the whole
 * request, and a single 500 across 56 combinations tells you nothing about which.
 */
/**
 * What each generating unit normally does, hour by hour.
 *
 * "Gönyű is at 340 MW" is a number, not information. The reader's actual question is
 * whether that is a lot, and answering it needs a yardstick - and the two obvious
 * yardsticks are both wrong on their own:
 *
 *   - Nameplate capacity alone flatters baseload and libels solar. A PV farm at 8% of
 *     nameplate is either midnight or a catastrophe, and nothing in the number says
 *     which.
 *   - A flat daily average is worse for exactly the same reason: averaging a solar
 *     unit's midnight zeros with its noon peak produces a figure it is never at.
 *
 * So the baseline is per unit AND per hour of day. A gas turbine that runs the evening
 * peak gets compared against its own evenings; Paks gets compared against a flat line,
 * because that is what a flat line looks like in this document.
 *
 * One request per day - the platform refuses A73 windows wider than a day and says so -
 * walked backwards, sequentially, because this is a free public service.
 */
async function probeUnitHistory(args = []) {
  console.log('\n########## per-unit generation history (A73) ##########');
  const entsoe = require('../sources/entsoe');
  const cfg = entsoe.config();
  if (!cfg.token) {
    console.log(cfg.tokenError || 'ENTSOE_TOKEN is not set, so nothing can be requested.');
    return;
  }

  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const DAYS = Number(arg('days')) || 60;
  const now = new Date();

  // unit -> hour -> samples, plus whole-unit tallies
  const byUnit = new Map();
  const touch = (name) => {
    if (!byUnit.has(name)) {
      byUnit.set(name, {
        hours: Array.from({ length: 24 }, () => []),
        all: [],
        days: new Set(),
        nominal: null,
        sourceType: null,
        max: null,
      });
    }
    return byUnit.get(name);
  };

  let reached = 0;
  for (let back = 1; back <= DAYS; back += 1) {
    const day = new Date(now.getTime() - back * 86400000);
    try {
      const out = await entsoe.fetchUnitGenerationDay(day);
      if (!out.units.length) {
        console.log(`  ${out.date}: no units`);
        continue;
      }
      reached += 1;
      for (const unit of out.units) {
        const entry = touch(unit.unitName);
        if (unit.nominalMw != null) entry.nominal = unit.nominalMw;
        if (unit.sourceType) entry.sourceType = unit.sourceType;
        entry.days.add(out.date);
        for (const point of unit.series || []) {
          const hour = new Date(point.at).getUTCHours();
          if (!Number.isFinite(point.mw)) continue;
          entry.hours[hour].push(point.mw);
          entry.all.push(point.mw);
          if (entry.max === null || point.mw > entry.max) entry.max = point.mw;
        }
      }
      if (back % 10 === 0 || back === 1) {
        console.log(`  ${out.date}: ${out.units.length} units, ${byUnit.size} seen so far`);
      }
    } catch (err) {
      console.log(`  ${day.toISOString().slice(0, 10)}: FAILED ${entsoe.describeError(err).slice(0, 90)}`);
    }
  }

  const out = {};
  console.log(`\n${byUnit.size} units over ${reached}/${DAYS} days:\n`);
  for (const [name, entry] of [...byUnit.entries()].sort((a, b) => (b[1].max || 0) - (a[1].max || 0))) {
    const mean = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
    const hourly = entry.hours.map(mean);
    out[name] = {
      sourceType: entry.sourceType,
      nominalMw: entry.nominal,
      // Per hour of day, in UTC - the same clock the series arrives on, so no timezone
      // guess sits between the baseline and the reading it will be compared with.
      hourlyMeanMw: hourly,
      meanMw: mean(entry.all),
      maxMw: entry.max,
      days: entry.days.size,
      samples: entry.all.length,
    };
    console.log(
      `  ${name.padEnd(26)} ${String(entry.sourceType || '?').padEnd(11)}` +
        ` mean ${String(mean(entry.all) ?? '-').padStart(7)}  max ${String(entry.max ?? '-').padStart(7)}` +
        `  of ${String(entry.nominal ?? '?').padStart(5)} MW  ${String(entry.days.size).padStart(3)} days`,
    );
  }

  // Does every registered plant's pattern actually match something?
  //
  // The pattern written from expectation ('^paks') matched none of the eight PA_gép
  // generators, and a pattern that matches nothing reports a plant as fully available
  // forever rather than failing. That bug is silent by construction, so it gets a check.
  console.log('\nplant pattern -> units matched:');
  for (const plant of require('../config/powerplants').listPlants('operating')) {
    if (!plant.entsoeUnitPattern) {
      console.log(`  ${plant.id.padEnd(16)} (no pattern)`);
      continue;
    }
    const matcher = new RegExp(plant.entsoeUnitPattern, 'i');
    const hits = [...byUnit.keys()].filter((n) => matcher.test(n));
    console.log(
      `  ${plant.id.padEnd(16)} ${String(hits.length).padStart(2)}  ${hits.join(', ') || 'NOTHING MATCHED'}`,
    );
  }

  emitDocument('unit-history', out, 'src/config/unit-history.json');
}

/**
 * The official drought index itself, not a substitute for it.
 *
 * The page currently says "not an official drought index", and the honest way to delete
 * that sentence is to publish the official one rather than to build something adjacent
 * and call it official. Hungary has exactly one: the Aszálymonitoring service run by OVF
 * and the chamber of agriculture, which publishes a Hungarian Drought Index per station.
 *
 * It has no JSON API. It is a server-rendered PHP page whose form carries three fields -
 * `drought_station` (a station GUID), `searchsettlement` and `drought_forecast_model` -
 * so the numbers are reachable only by asking the form the question a visitor would ask
 * and reading the page it returns.
 *
 * This probe establishes whether that is viable and what the answer looks like. It is
 * deliberately one station: if the shape is wrong, thirty requests would learn the same
 * thing thirty times over at someone else's expense.
 */
async function probeDroughtIndex(args = []) {
  console.log('\n########## official drought index (aszalymonitoring) ##########');
  const BASE = 'https://aszalymonitoring.vizugy.hu/index.php';

  const { body: home } = await fetchText(BASE, { timeoutMs: 25000 });
  console.log(`front page: ${home.length} bytes`);

  // Every station the form offers, not the first twelve.
  const stations = [...home.matchAll(/<option[^>]*value=["']([0-9A-F-]{36})["'][^>]*>([^<]*)</gi)]
    .map((m) => ({ guid: m[1], name: m[2].trim() }));
  console.log(`stations in the form: ${stations.length}`);
  if (!stations.length) {
    console.log('  no GUID options - the form has changed shape, nothing further is safe to guess');
    return;
  }
  console.log(`  first: ${stations[0].name} ${stations[0].guid}`);
  console.log(`  last:  ${stations[stations.length-1].name} ${stations[stations.length-1].guid}`);

  // Anything else the form needs. A hidden token or a CSRF field would make this
  // unworkable, so it is worth knowing before building anything.
  const hidden = [...home.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)].map((m) => m[0]);
  console.log(`hidden inputs: ${hidden.length}${hidden.length ? ` -> ${hidden.slice(0,4).join(' ')}` : ''}`);

  const pick = args.find((a) => a.startsWith('--station='));
  const station = pick
    ? stations.find((s) => s.name.toLowerCase().includes(pick.slice(10).toLowerCase())) || stations[0]
    : stations[0];
  console.log(`\nasking for: ${station.name}`);

  const form = new URLSearchParams({ drought_station: station.guid, searchsettlement: station.name });
  const { body, contentType } = await fetchText(BASE, {
    method: 'POST',
    body: form.toString(),
    timeoutMs: 30000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...browserHeaders('https://aszalymonitoring.vizugy.hu') },
  });
  console.log(`response: ${contentType} ${body.length} bytes (front page was ${home.length})`);
  if (body.length === home.length) {
    console.log('  identical length to the front page: the POST probably did not select anything');
  }

  // What arrived that was not there before. A diff is the fastest way to find the numbers
  // in 26 KB of page furniture.
  const numbers = [...body.matchAll(/(-?\d+[.,]\d+)/g)].map((m) => m[1]);
  const homeNumbers = new Set([...home.matchAll(/(-?\d+[.,]\d+)/g)].map((m) => m[1]));
  const fresh = numbers.filter((n) => !homeNumbers.has(n));
  console.log(`decimals: ${numbers.length} in the response, ${fresh.length} of them new`);
  if (fresh.length) console.log(`  new: ${fresh.slice(0, 24).join(' ')}`);

  // The index by name, in whatever the service calls it.
  for (const term of ['HDI', 'aszályindex', 'Aszályindex', 'aszályossági', 'talajnedvesség', 'indexérték']) {
    let at = body.indexOf(term);
    let shown = 0;
    while (at >= 0 && shown < 2) {
      console.log(`  "${term}" @${at}: ${body.slice(Math.max(0, at-90), at+160).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`);
      at = body.indexOf(term, at + 1); shown += 1;
    }
  }

  // Charts are usually the data in disguise: a JS array literal, or an <img> built from
  // a query string that names the station and the date range.
  const arrays = [...body.matchAll(/\[\s*(?:\[|\{|-?\d+[.,]?\d*\s*,)[\s\S]{0,220}?\]/g)].slice(0, 4);
  if (arrays.length) {
    console.log(`\n${arrays.length} array-shaped literal(s):`);
    for (const a of arrays) console.log(`  ${a[0].replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const imgs = [...body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1])
    .filter((u) => /\?|chart|graph|diagram|png|svg/i.test(u)).slice(0, 8);
  if (imgs.length) { console.log('\nimage sources:'); for (const u of imgs) console.log(`  ${u}`); }

  const tables = [...body.matchAll(/<table[\s\S]*?<\/table>/gi)];
  console.log(`\n${tables.length} table(s)`);
  for (const [i, t] of tables.slice(0, 2).entries()) {
    const text = t[0].replace(/<[^>]*>/g, ' | ').replace(/\s+/g, ' ').trim();
    console.log(`  table ${i}: ${text.slice(0, 600)}`);
  }

  // The page's own scripts, which is where the endpoint lives when the page does not
  // carry the data itself.
  //
  // This is the method that cracked data.vizugy.hu: a single-page front end's HTML is
  // empty, but the bundle it loads contains the URLs it calls as plain string literals.
  // Here the page announces that its measurements are "also available through the DWMS
  // Vízhiány application" - and an app has to fetch from somewhere, so somewhere is
  // named in something this page or that app loads.
  const scripts = [...home.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const styles = [...home.matchAll(/<link[^>]+href=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]);
  const assets = [...new Set([...scripts, ...styles])];
  console.log(`\n${assets.length} script(s) referenced:`);

  const ORIGIN = 'https://aszalymonitoring.vizugy.hu/';
  const INTERESTING = /(aszaly|drought|vizhiany|vízhiány|dwms|station|allomas|getdata|service|rest|api|json|ajax)/i;
  for (const src of assets) {
    if (/^https?:\/\//i.test(src) && !src.includes('vizugy.hu')) {
      console.log(`  (third party, skipped) ${src}`);
      continue;
    }
    const url = new URL(src, ORIGIN).toString();
    try {
      const { body: js } = await fetchText(url, { timeoutMs: 20000 });
      const hits = new Set();
      for (const m of js.matchAll(/["'`]([^"'`\s]{4,160})["'`]/g)) {
        const v = m[1];
        if (!INTERESTING.test(v)) continue;
        if (/\.(png|jpg|jpeg|gif|svg|css|woff2?|ttf)$/i.test(v)) continue;
        if (/^[#.]/.test(v)) continue;   // selectors, not URLs
        hits.add(v);
      }
      console.log(`  ${url}  ${js.length} bytes, ${hits.size} candidate(s)`);
      for (const h of [...hits].slice(0, 18)) console.log(`      ${h}`);

      // The call sites themselves, which is where the URL actually is.
      //
      // Listing interesting-looking string literals finds DOM ids and translation keys;
      // it does not find a path built by concatenation at the point of the request, and
      // that is exactly how these are written. Printing the code around each ajax call
      // shows the URL being assembled, parameters and all.
      // The one function that fetches, printed at length.
      //
      // The call-site scan found `var url = "index.php"` inside showDroughtData and
      // stopped there, which says where the request goes and not what it carries. The
      // parameter names are the whole remaining question - a POST with the wrong ones
      // returns the front page byte for byte, which is exactly what happened.
      const FETCHER = /function\s+showDroughtData[\s\S]{0,2600}/;
      const fetcher = FETCHER.exec(js);
      if (fetcher) {
        console.log('      ----- showDroughtData -----');
        for (const line of fetcher[0].split(/\n/).slice(0, 60)) {
          const t = line.trim();
          if (t) console.log(`      | ${t.slice(0, 170)}`);
        }
        console.log('      ----- end -----');
      }

      const CALLS = /(\$\.(?:ajax|get|post|getJSON)\s*\(|\.load\s*\(\s*["'`]|url\s*:\s*)/g;
      const seen = new Set();
      let call;
      while ((call = CALLS.exec(js)) !== null) {
        const snippet = js.slice(call.index, call.index + 230).replace(/\s+/g, ' ');
        if (seen.has(snippet.slice(0, 60))) continue;
        seen.add(snippet.slice(0, 60));
        if (seen.size > 8) break;
        console.log(`      CALL  ${snippet}`);
      }
    } catch (err) {
      console.log(`  ${url}  FAILED ${err.message.split('\n')[0].slice(0, 60)}`);
    }
  }
  // The parameter spellings, tried against the one thing that distinguishes a hit: the
  // response stops being byte-identical to the front page.
  //
  // The commented-out debug line left in their own source names the shape -
  // index.php?settlement=Fert%C5%91d - and the form fields name two more. Five GETs
  // settles which of them the server actually reads, and a probe that guesses in a loop
  // against someone else's service is worse than one that guesses five times and stops.
  console.log('\n--- which parameter does it read? ---');
  const tries = [
    `?settlement=${encodeURIComponent(station.name)}`,
    `?drought_station=${station.guid}`,
    `?searchsettlement=${encodeURIComponent(station.name)}`,
    `?settlement=${encodeURIComponent(station.name)}&drought_station=${station.guid}`,
    `?station=${station.guid}`,
    `?settlement=${encodeURIComponent(station.name)}&interval=daily`,
  ];

  const attempts = [];
  for (const query of tries) {
    try {
      const res = await fetchText(`${BASE}${query}`, {
        timeoutMs: 25000,
        headers: browserHeaders('https://aszalymonitoring.vizugy.hu'),
      });
      const same = res.body.length === home.length;
      const dataAt = res.body.indexOf('DROUGHT_DATA');
      attempts.push({
        query,
        bytes: res.body.length,
        identicalToFrontPage: same,
        droughtDataAt: dataAt,
        // A generous slice around the assignment: the shape of that object is the whole
        // parsing problem, and guessing at it from a 60-character log line is how a
        // scraper ends up matching the wrong number.
        sample: dataAt >= 0 ? res.body.slice(dataAt, dataAt + 1800) : null,
      });
      console.log(
        `  ${query.slice(0, 66).padEnd(66)} ${String(res.body.length).padStart(7)} bytes` +
          `${same ? '  (same as front page)' : '  <-- DIFFERENT'}${dataAt >= 0 ? `  DROUGHT_DATA @${dataAt}` : ''}`,
      );
    } catch (err) {
      attempts.push({ query, error: err.message.split('\n')[0] });
      console.log(`  ${query.slice(0, 66)}  FAILED ${err.message.split('\n')[0].slice(0, 50)}`);
    }
  }

  // Emitted rather than only logged.
  //
  // Reading this out of a job log has failed repeatedly - the interesting lines sit above
  // whatever window the log API returns - and the answer here is a 1800-character sample
  // that a log line would truncate anyway. The document goes to the branch and can be
  // read at leisure.
  // The two pieces of source that define the request, in full.
  //
  // Six URL spellings all returned the front page byte for byte, which means the shape
  // is not a GET parameter at all and no further guessing is justified. autodroughtload.js
  // is 3.6 KB - small enough to read whole - and it is the script that makes the FIRST
  // request on page load, so whatever it does is the request. The window after
  // `var url = "index.php"` in hydroinfo_v5.js carries the $.ajax config with its `data`.
  const sources = {};
  for (const [name, url] of [
    ['autodroughtload', 'https://aszalymonitoring.vizugy.hu/js/autodroughtload.js'],
    ['hydroinfo', 'https://aszalymonitoring.vizugy.hu/js/hydroinfo_v5.js'],
  ]) {
    try {
      const { body: js } = await fetchText(url, { timeoutMs: 25000 });
      if (name === 'autodroughtload') {
        sources[name] = js;                       // whole file, it is tiny
      } else {
        const at = js.indexOf('var url = "index.php"');
        sources[name] = at >= 0 ? js.slice(Math.max(0, at - 800), at + 3200) : null;
      }
    } catch (err) {
      sources[name] = `FAILED ${err.message.split('\n')[0]}`;
    }
  }

  // Where the rasters live.
  //
  // The page's own config names three ArcGIS ImageServers - mosaic_hdis for the drought
  // index itself, mosaic_pr for precipitation, mosaic_tm for temperature - as RELATIVE
  // paths, so the base is a constant elsewhere in their code. That route matters: an
  // ImageServer is a documented, machine-readable GIS service, which is a different kind
  // of thing from a form the same site guards with a hidden honeypot field.
  const arc = new Set();
  for (const src of assets) {
    if (/^https?:\/\//i.test(src) && !src.includes('vizugy.hu')) continue;
    try {
      const { body: js } = await fetchText(new URL(src, ORIGIN).toString(), { timeoutMs: 20000 });
      for (const m of js.matchAll(/["'`]([^"'`\s]*(?:arcgis|rest\/services|ImageServer|MapServer)[^"'`\s]*)["'`]/gi)) {
        arc.add(m[1]);
      }
      // A base assembled from a variable rather than written whole.
      for (const m of js.matchAll(/[A-Za-z_$][\w$]*\s*=\s*["'`](https?:\/\/[^"'`\s]+)["'`]/g)) {
        if (/arcgis|gis|map|server/i.test(m[1])) arc.add(m[1]);
      }
    } catch { /* already reported above */ }
  }
  console.log(`\n--- ArcGIS references (${arc.size}) ---`);
  for (const a of [...arc].slice(0, 30)) console.log(`  ${a}`);

  // Ask the GIS service, which is the interface built to be asked.
  //
  // https://geoportal.vizugy.hu/arcgis/rest/services/Aszalymon/ carries the station layer
  // and the drought-index raster as a standard ArcGIS REST service: ?f=json for metadata,
  // /query for features, /identify for a value at a point. This is a published machine
  // interface with a documented protocol, and querying it is what it exists for - unlike
  // the settlement form on the front end, which the site guards with a hidden field its
  // own source calls a bot trap. Where an operator has expressed a preference that
  // clearly, the answer is to use the door they left open, not to get better at the one
  // they locked.
  const GIS = 'https://geoportal.vizugy.hu/arcgis/rest/services/Aszalymon';
  const gis = {};
  const askGis = async (label, url) => {
    try {
      const body = await fetchJson(url, { timeoutMs: 30000 });
      gis[label] = body;
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      console.log(`  ${label.padEnd(22)} OK    keys: ${keys.slice(0, 12).join(', ')}`);
      if (body && body.error) console.log(`      error: ${JSON.stringify(body.error).slice(0, 200)}`);
      return body;
    } catch (err) {
      gis[label] = { fetchError: err.message.split('\n')[0] };
      console.log(`  ${label.padEnd(22)} FAIL  ${err.message.split('\n')[0].slice(0, 70)}`);
      return null;
    }
  };

  console.log('\n--- the GIS service ---');
  await askGis('service-root', `${GIS}?f=json`);
  await askGis('hdi-imageserver', `${GIS}/mosaic_hdis/ImageServer?f=json`);
  const layer = await askGis('station-layer', `${GIS}/Aszaly_monitoring_allomasok/MapServer/0?f=json`);
  if (layer && Array.isArray(layer.fields)) {
    console.log(`      fields: ${layer.fields.map((f) => `${f.name}:${f.type.replace('esriFieldType','')}`).join(' ')}`);
  }
  // Everything the station layer holds. 139 stations is one small response, and the
  // attributes decide whether the index is already on the features or has to come from
  // the raster.
  await askGis('stations', `${GIS}/Aszaly_monitoring_allomasok/MapServer/0/query` +
    `?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json`);

  emitDocument('drought-index-scan', {
    arcgis: [...arc],
    gis,
    stations: stations.length,
    stationSample: stations.slice(0, 3),
    frontPageBytes: home.length,
    hiddenInputs: hidden.length,
    attempts,
    sources,
  }, 'src/config/aszaly-stations.json (after review)');
}

/**
 * Everything the water directorate's geoportal publishes.
 *
 * The drought hunt turned up geoportal.vizugy.hu/arcgis/rest/services and only looked
 * inside one folder. An ArcGIS root enumerates itself - folders and services, with their
 * layers - so one request says what else is there, and three open questions all depend on
 * the answer:
 *
 *   - WATERCOURSES. The map draws rivers from Natural Earth at 10m, which is a world
 *     dataset: it knows the Danube and the Tisza and almost nothing else. Every creek in
 *     the country is a national hydrography layer, and this is where one would live.
 *   - WASTEWATER. Where treated effluent enters a river is a fact about that river that
 *     this site cannot currently show at all.
 *   - Anything else published for machines rather than for a map viewer.
 *
 * Read-only enumeration of a public catalogue, which is what the endpoint is for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE HAS A DEADLINE AND WRITES AS IT GOES
 * ---------------------------------------------------------------------------
 * The first attempt at this ran for twenty-five minutes without emitting a line and was
 * killed, losing everything it had learned. Every other probe in this file asks a known
 * service a known number of questions; this one asks an UNKNOWN catalogue however many
 * questions it turns out to contain, and a slow or unfriendly host multiplies that by the
 * per-request timeout. Unbounded work with an all-or-nothing write at the end is the
 * worst possible shape for that.
 *
 * So: a wall-clock deadline checked before every request, the partial document written
 * after every folder, and no retry. A retry on an enumeration doubles the cost of exactly
 * the requests that are already too slow, and a folder that times out twice tells us
 * nothing a folder that timed out once did not.
 */
/**
 * Every watercourse in the country, and where treated sewage enters them.
 *
 * ---------------------------------------------------------------------------
 * WHY OPENSTREETMAP AND NOT THE OFFICIAL LAYER
 * ---------------------------------------------------------------------------
 * The map draws rivers from Natural Earth 10m, and inside the frame that dataset yields
 * THIRTY-SEVEN lines - the Danube, the Tisza, the Rába, and then it stops. It is a world
 * dataset doing a world dataset's job. A reader looking for the stream behind their
 * village will not find it, and no amount of styling fixes a dataset that does not
 * contain the object.
 *
 * The water directorate's own hydrography would be the authoritative source and is being
 * asked for separately (--geoportal). It may or may not be published for machines. OSM
 * is asked here because it is unambiguously open, unambiguously complete enough - Hungary
 * is well mapped - and carries the names in Hungarian, which a world dataset does not.
 * If the official layer turns out to be usable, it wins on provenance and this becomes
 * the fallback. Until then, "we could not show it" is the worse answer.
 *
 * ---------------------------------------------------------------------------
 * COUNTS BEFORE GEOMETRY
 * ---------------------------------------------------------------------------
 * This asks how many of each kind exist BEFORE asking for any of them. `out count` is one
 * cheap query and it decides everything downstream: whether streams can be shipped whole
 * or only the named ones, what simplification tolerance the file can afford, whether the
 * browser gets one document or two. Guessing those parameters and discovering the answer
 * from a 60 MB response is the expensive order to do this in - for this project and for
 * the volunteers' server.
 *
 * This is a bake, not a runtime dependency: it runs by hand, its output is committed, and
 * the site never calls Overpass. Same contract as Natural Earth in scripts/build-geo.js.
 */
async function probeWaters(args = []) {
  console.log('\n########## watercourses, from OpenStreetMap ##########');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const ENDPOINT = arg('overpass') || 'https://overpass-api.de/api/interpreter';
  const DEADLINE_MS = (Number(arg('deadline')) || 20) * 60000;
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  // One query at a time, with a pause between. Overpass is volunteer-run infrastructure
  // and this is a batch job with nobody waiting on it, so it goes at the server's pace.
  const ask = async (name, query, { timeoutMs = 300000 } = {}) => {
    const { body } = await fetchText(ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ data: query }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs,
      retries: 0,
    });
    await sleep(2000);
    return body;
  };

  const AREA = 'area["ISO3166-1"="HU"][admin_level=2]->.hu;';
  const out = { source: 'OpenStreetMap via Overpass', endpoint: ENDPOINT, counts: {}, sizes: {} };

  // ---- how much is there ----
  const KINDS = ['river', 'stream', 'canal', 'ditch', 'drain'];
  console.log('counting first, so the geometry request can be sized:\n');
  for (const kind of KINDS) {
    for (const [label, filter] of [[kind, ''], [`${kind} (named)`, '["name"]']]) {
      if (outOfTime()) break;
      try {
        const body = await ask(
          `count-${label}`,
          `[out:json][timeout:180];${AREA}way(area.hu)["waterway"="${kind}"]${filter};out count;`,
          { timeoutMs: 200000 },
        );
        const n = Number(JSON.parse(body).elements?.[0]?.tags?.ways ?? NaN);
        out.counts[label] = n;
        console.log(`  ${label.padEnd(18)} ${String(n).padStart(7)} ways   [${elapsed()}]`);
      } catch (err) {
        out.counts[label] = { error: err.message.split('\n')[0] };
        console.log(`  ${label.padEnd(18)}   FAILED ${err.message.split('\n')[0].slice(0, 60)}`);
      }
    }
  }
  writeDocument('waters-scan', out);

  // ---- the geometry we are confident about ----
  // Rivers and canals are the backbone and there are not many of them. Streams are asked
  // for separately and only if the count above says they fit.
  const fetchGeometry = async (label, selector) => {
    if (outOfTime()) { console.log(`  ${label}: skipped, deadline`); return null; }
    console.log(`\nfetching ${label} geometry ...`);
    try {
      const body = await ask(label, `[out:json][timeout:600];${AREA}(${selector});out tags geom;`, { timeoutMs: 600000 });
      out.sizes[label] = body.length;
      console.log(`  ${label}: ${body.length} bytes raw  [${elapsed()}]`);
      const file = writeRaw(`waters-${label}`, body);
      if (file) console.log(`  raw kept at ${file} (artifact only, never committed)`);
      return JSON.parse(body);
    } catch (err) {
      out.sizes[label] = { error: err.message.split('\n')[0] };
      console.log(`  ${label}: FAILED ${err.message.split('\n')[0].slice(0, 80)}`);
      return null;
    }
  };

  const collected = [];
  const big = await fetchGeometry('rivers-canals',
    `way(area.hu)["waterway"="river"];way(area.hu)["waterway"="canal"];`);
  if (big) collected.push(...(big.elements || []));

  // Named streams only unless the count says everything fits. An unnamed ditch behind a
  // field is real, but it is not what "jelenjen meg minden vizünk" is asking for, and it
  // is the difference between a file a phone can load and one it cannot.
  const streamCount = out.counts['stream (named)'];
  if (Number.isFinite(streamCount) && streamCount > 0) {
    const streams = await fetchGeometry('streams-named', `way(area.hu)["waterway"="stream"]["name"];`);
    if (streams) collected.push(...(streams.elements || []));
  }

  console.log(`\n${collected.length} ways collected  [${elapsed()}]`);
  if (collected.length) {
    const { reduceWays } = require('../../scripts/geometry');
    for (const tol of [0.0005, 0.0002, 0.0001]) {
      const reduced = reduceWays(collected, { tolerance: tol, decimals: 4 });
      const bytes = JSON.stringify(reduced).length;
      console.log(`  tolerance ${tol}: ${reduced.length} features, ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
      out.sizes[`reduced@${tol}`] = bytes;
    }
    // 0.0002 degrees is about 20 m, which is a tenth of a screen unit at full zoom on
    // this map - below what anyone can see, and above what costs real bytes.
    out.features = reduceWays(collected, { tolerance: 0.0002, decimals: 4 });
  }

  emitDocument('waters', out, 'public/waters.json (after review)');
}

/**
 * Where the country's sewage goes back into the country's water.
 *
 * A reader asking about the Danube at Budapest is asking, whether they say so or not,
 * about the Central Wastewater Treatment Plant on Csepel - which treats the sewage of
 * roughly 1.6 million people and returns it to the Danube at the bottom of the city. That
 * is a fact about that river at that point, and the site cannot currently show it at all.
 *
 * Two things are wanted per plant and they are not the same thing:
 *
 *   - WHERE it discharges, which is what puts it on a map, and
 *   - HOW MUCH, which is what makes it mean anything. A village plant and Csepel are the
 *     same dot otherwise, and drawing them the same size would be its own kind of lie.
 *
 * OSM has the locations and the names reliably. Capacity is tagged inconsistently, so
 * whatever is there is collected and reported as coverage rather than assumed. Nothing
 * here estimates a load from a population: that would be a modelled number wearing a
 * measurement's clothes, and this project does not do that.
 */
async function probeSewage(args = []) {
  console.log('\n########## wastewater treatment plants ##########');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const ENDPOINT = arg('overpass') || 'https://overpass-api.de/api/interpreter';
  const AREA = 'area["ISO3166-1"="HU"][admin_level=2]->.hu;';

  const ask = async (query, timeoutMs = 300000) => {
    const { body } = await fetchText(ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ data: query }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs,
      retries: 0,
    });
    await sleep(2000);
    return body;
  };

  const out = { source: 'OpenStreetMap via Overpass', plants: [], tagCoverage: {}, outfalls: null };

  // `nwr` rather than `way`: a plant is mapped as an area in a city and as a single node
  // in a village, and asking only for ways would silently drop every small settlement -
  // which is most of them, and exactly the ones a national picture needs.
  try {
    const body = await ask(
      `[out:json][timeout:300];${AREA}nwr(area.hu)["man_made"="wastewater_plant"];out tags center;`,
    );
    writeRaw('sewage-plants', body);
    const elements = JSON.parse(body).elements || [];
    console.log(`${elements.length} wastewater plants`);

    for (const el of elements) {
      const t = el.tags || {};
      for (const key of Object.keys(t)) out.tagCoverage[key] = (out.tagCoverage[key] || 0) + 1;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.plants.push({
        osm: `${el.type}/${el.id}`,
        name: t.name || t.operator || null,
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        operator: t.operator || null,
        // Whatever they used. Reported as found, converted by nobody.
        capacity: t.capacity || t['capacity:pe'] || t.population_equivalent || null,
        startDate: t.start_date || null,
      });
    }

    const named = out.plants.filter((p) => p.name).length;
    const withCapacity = out.plants.filter((p) => p.capacity).length;
    console.log(`  ${named} named, ${withCapacity} with any capacity tag`);
    console.log('\ntags present, by frequency:');
    for (const [k, n] of Object.entries(out.tagCoverage).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      console.log(`  ${String(n).padStart(5)}  ${k}`);
    }
  } catch (err) {
    out.plants = { error: err.message.split('\n')[0] };
    console.log(`FAILED: ${err.message.split('\n')[0]}`);
  }
  writeDocument('sewage', out);

  // The pipe's mouth, where it exists. A plant's building is a few hundred metres from
  // the point the treated water actually enters the river, and on a map at national scale
  // that difference is invisible - but where an outfall IS mapped it is the truer point,
  // so it is collected and kept separate rather than merged into the plant.
  try {
    const body = await ask(`[out:json][timeout:180];${AREA}nwr(area.hu)["outlet"="wastewater"];out tags center;`);
    const elements = JSON.parse(body).elements || [];
    out.outfalls = elements.map((el) => ({
      osm: `${el.type}/${el.id}`,
      name: (el.tags || {}).name || null,
      lat: Math.round((el.lat ?? el.center?.lat) * 10000) / 10000,
      lon: Math.round((el.lon ?? el.center?.lon) * 10000) / 10000,
    })).filter((o) => Number.isFinite(o.lat));
    console.log(`\n${out.outfalls.length} mapped wastewater outfalls`);
  } catch (err) {
    out.outfalls = { error: err.message.split('\n')[0] };
    console.log(`\noutfalls FAILED: ${err.message.split('\n')[0].slice(0, 80)}`);
  }

  emitDocument('sewage', out, 'src/config/sewage.js (after review)');
}

/**
 * The plants' actual size, from the European register that exists precisely to record it.
 *
 * WHY OSM WAS NOT ENOUGH, MEASURED RATHER THAN ASSUMED
 *
 * The --sewage probe found 662 objects tagged man_made=wastewater_plant in Hungary and
 * exactly ZERO of them carried any capacity tag. It also found that the tag is being used
 * for things that do not treat anything: "Szennyvízátemelő" is a pumping station and
 * "Szennyvíztároló" is a holding tank, and both are in that 662.
 *
 * So OSM answers where and does not answer how much - which is the half that matters.
 * Drawing 662 identical dots would say that the works treating the sewage of 1.6 million
 * people on Csepel and a village pumping station are the same kind of object, and a map
 * that says that is worse than a map that says nothing.
 *
 * The Urban Waste Water Treatment Directive obliges every member state to report each
 * agglomeration's plants with their design capacity in population equivalent, the load
 * actually arriving, the treatment applied, and THE RECEIVING WATER BODY - which is the
 * field that turns a dot into a fact about a particular river. The EEA publishes the
 * result. That register is the right source for this, and OSM becomes what it is good at:
 * a check on where the buildings are.
 *
 * Enumerates before querying, for the same reason --geoportal does: the layer ids in a
 * public ArcGIS catalogue are not guessable and change between editions.
 */
/**
 * One ArcGIS layer, asked what it is before being asked for anything.
 *
 * The geoportal enumeration found the two layers this project had been looking for -
 * Honlap/Vizfolyasok (the national watercourses) and Honlap/Vizikozmu layer 0, which is
 * literally named "Szennyviztisztito telepek kapacitasa (LE)": the treatment plants WITH
 * their capacity in population equivalent, the field OSM did not have on a single one of
 * its 662 objects.
 *
 * Three questions in a fixed order, because getting them out of order is how a probe ends
 * up downloading a hundred thousand features to find out it wanted a different column:
 *
 *   1. What fields does it have, and what geometry?
 *   2. How many features are there? (returnCountOnly - one cheap request)
 *   3. Only then, and only when asked, the features themselves - paged, because ArcGIS
 *      caps a response at maxRecordCount and silently returns a truncated set with
 *      exceededTransferLimit rather than an error.
 *
 * That last one has bitten enough people to be worth stating: a query that returns
 * exactly 1000 features has almost certainly not returned all of them.
 */
async function probeLayer(args = []) {
  console.log('\n########## ArcGIS layer inspection ##########');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const layers = args.filter((a) => a.startsWith('--layer=')).map((a) => a.slice(8));
  if (!layers.length) {
    console.log('nothing to inspect: pass --layer=<url> (repeatable)');
    return;
  }

  const where = arg('where') || '1=1';
  const fetchAll = args.includes('--fetch');
  const outName = arg('out') || 'layer';
  const geometry = !args.includes('--no-geometry');
  // Overridable, because this geoportal is intermittently slow rather than reliably
  // slow: the same two layers answered a metadata request in under a second, and timed
  // out on both attempts forty minutes later. The enumeration probe must not retry - it
  // asks hundreds of questions and a retry doubles the cost of exactly the slow ones -
  // but this one asks two, and giving up on a flaky host after 30 seconds means never
  // getting the answer.
  const REQ = {
    timeoutMs: Number(arg('timeout')) || 30000,
    retries: Number(arg('retries')) || 0,
  };
  const out = {};

  for (const url of layers) {
    const record = { url };
    out[url] = record;
    console.log(`\n=== ${url}`);
    try {
      const meta = await fetchJson(`${url}?f=json`, REQ);
      // A layer calls it `name`, a whole service calls it `mapName`. Reading only the
      // first prints "name: undefined" for every service and makes a live endpoint look
      // like a broken one.
      record.name = meta.name || meta.mapName || meta.serviceDescription || null;
      record.geometryType = meta.geometryType || null;
      record.maxRecordCount = meta.maxRecordCount || null;
      record.fields = (meta.fields || []).map((f) => ({
        name: f.name, type: String(f.type).replace('esriFieldType', ''), alias: f.alias,
      }));
      console.log(`  name: ${meta.name}   geometry: ${meta.geometryType}   maxRecordCount: ${meta.maxRecordCount}`);
      // A URL ending at the service rather than at a layer answers with the service's
      // layer list instead of a field list. That is the only way to see inside a group
      // layer, and without printing it a service whose sublayers are the point looks
      // like an empty layer with no fields - which is exactly how the AKK flood services
      // read on three separate attempts.
      // Reported even when it is zero, and this is the whole point. Every one of the 24
      // AKK flood services answers normally - correct JSON, a maxRecordCount, no error -
      // and publishes an EMPTY layer list. Printing nothing for that is indistinguishable
      // from printing nothing for a plain feature layer, which is why three attempts at
      // the flood data read as "the probe did not work" rather than as the finding it is:
      // those services are published as map images, and there are no features to fetch.
      if (Array.isArray(meta.layers)) {
        record.layerCount = meta.layers.length;
        if (!meta.layers.length) {
          console.log('  0 sublayers - the service publishes no queryable layers ' +
            '(map images only; nothing here can be fetched as data)');
        }
      }
      if (Array.isArray(meta.layers) && meta.layers.length) {
        record.layers = meta.layers.map((l) => ({
          id: l.id, name: l.name, type: l.geometryType || l.type,
          parent: l.parentLayerId, sub: (l.subLayerIds || []).length,
        }));
        console.log(`  ${record.layers.length} sublayer(s):`);
        for (const l of record.layers) {
          console.log(`    ${String(l.id).padStart(3)}  ${(l.name || '').padEnd(46)}` +
            `${l.type || ''}${l.sub ? `  (group of ${l.sub})` : ''}`);
        }
      }
      // One step further out again: a URL ending at the REST root, or at a folder inside
      // it, answers with neither fields nor layers but with the catalogue - the folders
      // and services the host publishes. Printing it turns this from "inspect a layer I
      // already know about" into "find out what is here at all", which is the only way
      // in to a server whose service names are not documented anywhere.
      if (Array.isArray(meta.folders) && meta.folders.length) {
        record.folders = meta.folders;
        console.log(`  ${meta.folders.length} folder(s): ${meta.folders.join(' ')}`);
      }
      if (Array.isArray(meta.services) && meta.services.length) {
        record.services = meta.services.map((s) => `${s.name}/${s.type}`);
        console.log(`  ${record.services.length} service(s):`);
        for (const s of record.services) console.log(`    ${s}`);
      }
      console.log(`  fields: ${record.fields.map((f) => `${f.name}:${f.type}`).join(' ')}`);
      if (record.fields.some((f) => f.alias && f.alias !== f.name)) {
        console.log(`  aliases: ${record.fields.filter((f) => f.alias !== f.name).map((f) => `${f.name}="${f.alias}"`).join(' ')}`);
      }
    } catch (err) {
      record.error = err.message.split('\n')[0];
      console.log(`  metadata FAILED: ${record.error.slice(0, 100)}`);
      continue;
    }

    // A catalogue and a group layer have no rows to count, and asking anyway spends a
    // request to be told so. Skipped rather than tried-and-caught, because the failure
    // it prints reads like a broken endpoint when nothing is broken.
    if (record.folders || record.services || (record.layers && !record.fields.length)) {
      console.log('  (catalogue or group layer - no rows of its own; inspect a child)');
      writeDocument(outName, out);
      continue;
    }

    try {
      const counted = await fetchJson(
        `${url}/query?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`, REQ,
      );
      record.count = counted.count;
      console.log(`  count where ${where}: ${counted.count}`);
    } catch (err) {
      console.log(`  count FAILED: ${err.message.split('\n')[0].slice(0, 90)}`);
    }
    writeDocument(outName, out);

    if (!fetchAll) continue;

    const page = Math.min(record.maxRecordCount || 1000, 1000);
    const features = [];

    // Some joined MapServer views accept resultOffset and answer with nothing at all -
    // no error, no features, just an empty set while returnCountOnly happily reports 85.
    // A layer that says it has rows and then hands back none is a paging failure, not an
    // empty layer, so it is asked again the plain way before being written off.
    const unpaged = async () => {
      const body = await fetchJson(
        `${url}/query?where=${encodeURIComponent(where)}&outFields=*` +
        `&returnGeometry=${geometry}&outSR=4326&f=json`,
        { ...REQ, timeoutMs: Math.max(REQ.timeoutMs, 90000) },
      );
      return body.features || [];
    };
    for (let offset = 0; ; offset += page) {
      try {
        const body = await fetchJson(
          `${url}/query?where=${encodeURIComponent(where)}&outFields=*` +
          `&returnGeometry=${geometry}&outSR=4326&resultOffset=${offset}&resultRecordCount=${page}&f=json`,
          { ...REQ, timeoutMs: 90000 },
        );
        const batch = body.features || [];
        features.push(...batch);
        console.log(`    +${batch.length} (${features.length}${record.count ? '/' + record.count : ''})`);
        // Two stop conditions, both needed. A short page means the end; but a server that
        // ignores resultOffset would loop for ever returning full pages, so the known
        // count is the backstop.
        if (batch.length < page) break;
        if (record.count && features.length >= record.count) break;
        await sleep(500);
      } catch (err) {
        record.fetchError = err.message.split('\n')[0];
        console.log(`    FAILED at offset ${offset}: ${record.fetchError.slice(0, 90)}`);
        break;
      }
    }
    if (!features.length && record.count) {
      console.log(`    paged query returned nothing for ${record.count} rows; retrying without paging`);
      try {
        features.push(...await unpaged());
        console.log(`    unpaged: ${features.length}`);
      } catch (err) {
        console.log(`    unpaged FAILED: ${err.message.split('\n')[0].slice(0, 90)}`);
      }
    }

    record.fetched = features.length;
    record.sample = features.slice(0, 2);
    writeRaw(`${outName}-${features.length}`, JSON.stringify({ url, features }));

    if (record.geometryType === 'esriGeometryPoint') {
      record.points = features.map((f) => ({
        ...f.attributes,
        lon: f.geometry && Math.round(f.geometry.x * 10000) / 10000,
        lat: f.geometry && Math.round(f.geometry.y * 10000) / 10000,
      }));
    } else if (record.geometryType === 'esriGeometryPolyline') {
      // Reduced here rather than kept raw. Sixteen thousand watercourses arrive as
      // several hundred thousand fragments; drawn as they come they are unshippable and
      // unlabelable, and the reduction is the same one the OSM path uses - chain the
      // fragments of one named watercourse back together, then simplify the long run.
      const nameField = arg('name-field') || guessNameField(record.fields);
      const keep = (arg('keep') || '').split(',').filter(Boolean);
      console.log(`  reducing polylines, name field: ${nameField || '(none found)'}`);
      const elements = [];
      for (const f of features) {
        const a = f.attributes || {};
        const props = {};
        for (const k of keep) if (a[k] !== undefined && a[k] !== null && a[k] !== '') props[k] = a[k];
        for (const p of (f.geometry && f.geometry.paths) || []) {
          elements.push({
            tags: { name: nameField ? a[nameField] || null : null, waterway: arg('type') || 'vizfolyas' },
            geometry: p.map(([lon, lat]) => ({ lon, lat })),
            props,
          });
        }
      }
      const { reduceWays } = require('../../scripts/geometry');
      for (const tol of [0.0005, 0.0002]) {
        const r = reduceWays(elements, { tolerance: tol, decimals: 4 });
        const bytes = JSON.stringify(r).length;
        console.log(`    tolerance ${tol}: ${r.length} features, ${(bytes / 1048576).toFixed(2)} MB`);
      }
      record.features = reduceWays(elements, { tolerance: 0.0002, decimals: 4 });
      record.reducedFrom = elements.length;
      console.log(`  ${elements.length} paths -> ${record.features.length} watercourses`);
      console.log(`  longest: ${record.features.slice(0, 8).map((f) => `${f.name || '(névtelen)'} ${f.km}km`).join(', ')}`);
    } else if (record.geometryType === 'esriGeometryPolygon') {
      // Rings, simplified. A national layer of administrative districts is megabytes of
      // vertex at source and a few hundred kilobytes once it is drawn at the scale this
      // map draws it - and without this branch the polygons went only to the raw
      // artifact, which the commit deliberately cannot reach.
      const { simplify } = require('../../scripts/geometry');
      const tol = Number(arg('tolerance')) || 0.002;
      record.features = features.map((f) => ({
        ...f.attributes,
        rings: ((f.geometry && f.geometry.rings) || [])
          .map((ring) => simplify(ring, tol).map(([x, y]) => [round4(x), round4(y)]))
          // Three points is a line; a ring needs to close, so four is the minimum that
          // can enclose anything.
          .filter((ring) => ring.length >= 4),
      }));
      const pts = record.features.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);
      console.log(`  ${record.features.length} polygons, ${pts} points at tolerance ${tol}` +
        ` (${(JSON.stringify(record.features).length / 1048576).toFixed(2)} MB)`);
    } else {
      // Attributes are small and are what a human reviews; geometry of an unknown type
      // is neither, and stays in the artifact.
      record.attributes = features.map((f) => f.attributes);
    }
    writeDocument(outName, out);
  }

  emitDocument(outName, out, 'src/config/ (after review)');
}

/**
 * Which column holds the name.
 *
 * A guess with a stated shortlist rather than a hard-coded field: the two watercourse
 * layers on this geoportal call it VIZFOLYAS and Nev respectively, and a probe that only
 * knew one of them would quietly produce sixteen thousand unnamed lines - which looks
 * like working code and is a useless file. Overridable with --name-field= when the guess
 * is wrong, which is the case this exists to make cheap rather than to pretend away.
 */
function guessNameField(fields) {
  const names = (fields || []).map((f) => f.name);
  const preferred = ['VIZFOLYAS', 'Nev', 'NEV', 'name', 'NEV0', 'NevT'];
  for (const p of preferred) {
    const hit = names.find((n) => n === p || n.endsWith(`.${p}`));
    if (hit) return hit;
  }
  return names.find((n) => /nev|name/i.test(n)) || null;
}

async function probeUwwtd(args = []) {
  console.log('\n########## EEA urban waste water register ##########');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const DEADLINE_MS = (Number(arg('deadline')) || 10) * 60000;
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;
  const REQ = { timeoutMs: 20000, retries: 0 };

  const ROOTS = (arg('roots') || 'https://discomap.eea.europa.eu/arcgis/rest/services').split(',');
  const INTEREST = /(uww|waste ?water|urban|water)/i;
  const out = { roots: {}, services: {}, query: null };

  for (const ROOT of ROOTS) {
    try {
      const root = await fetchJson(`${ROOT}?f=json`, REQ);
      const folders = root.folders || [];
      out.roots[ROOT] = { folders, services: root.services || [] };
      console.log(`${ROOT}\n  ArcGIS ${root.currentVersion}, ${folders.length} folders  [${elapsed()}]`);
      console.log(`  folders: ${folders.join(', ')}`);

      for (const folder of folders.filter((f) => INTEREST.test(f))) {
        if (outOfTime()) break;
        try {
          const body = await fetchJson(`${ROOT}/${encodeURIComponent(folder)}?f=json`, REQ);
          const services = body.services || [];
          out.services[`${ROOT}/${folder}`] = services;
          console.log(`\n  --- ${folder}: ${services.length} service(s) ---`);
          for (const s of services) console.log(`      ${s.type.padEnd(11)} ${s.name}`);
        } catch (err) {
          console.log(`  --- ${folder}: FAILED ${err.message.split('\n')[0].slice(0, 60)}`);
        }
      }
    } catch (err) {
      out.roots[ROOT] = { error: err.message.split('\n')[0] };
      console.log(`${ROOT}\n  FAILED ${err.message.split('\n')[0].slice(0, 90)}`);
    }
    writeDocument('uwwtd', out);
  }

  // A layer named on the command line is queried directly - the enumeration above is for
  // finding it the first time, and hard-coding a guess would be the thing that breaks
  // silently when the register is republished.
  const layerUrl = arg('layer');
  if (layerUrl) {
    console.log(`\nquerying ${layerUrl}`);
    try {
      const meta = await fetchJson(`${layerUrl}?f=json`, REQ);
      console.log(`  ${meta.name}: ${(meta.fields || []).map((f) => f.name).join(' ')}`);
      out.query = { layer: layerUrl, fields: (meta.fields || []).map((f) => f.name) };

      const where = encodeURIComponent(arg('where') || "countryCode='HU'");
      const body = await fetchJson(
        `${layerUrl}/query?where=${where}&outFields=*&returnGeometry=true&outSR=4326&f=json`,
        { ...REQ, timeoutMs: 60000 },
      );
      const features = body.features || [];
      console.log(`  ${features.length} features`);
      out.query.count = features.length;
      out.query.sample = features.slice(0, 3);
      out.query.features = features.map((f) => ({ ...f.attributes, ...(f.geometry || {}) }));
    } catch (err) {
      out.query = { layer: layerUrl, error: err.message.split('\n')[0] };
      console.log(`  FAILED ${err.message.split('\n')[0].slice(0, 120)}`);
    }
  }

  emitDocument('uwwtd', out, 'src/config/sewage.js (after review)');
}

async function probeGeoportal(args = []) {
  console.log('\n########## geoportal.vizugy.hu catalogue ##########');
  const ROOT = 'https://geoportal.vizugy.hu/arcgis/rest/services';
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const DEADLINE_MS = (Number(arg('deadline')) || 12) * 60000;
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;
  const REQ = { timeoutMs: 15000, retries: 0 };

  const catalogue = { root: null, folders: {}, layers: {}, stoppedEarly: false };
  const INTEREST = /(viz|víz|foly|patak|csatorna|szennyviz|szennyvíz|hidro|hydro|vkj|vgt|meder|tavak|to_|allomas|állomás)/i;

  const root = await fetchJson(`${ROOT}?f=json`, REQ);
  const folders = root.folders || [];
  console.log(`ArcGIS ${root.currentVersion}, ${folders.length} folder(s), ${(root.services || []).length} service(s) at the root  [${elapsed()}]`);
  console.log(`folders: ${folders.join(', ')}`);
  catalogue.root = { folders, services: root.services || [] };
  writeDocument('geoportal', catalogue);

  for (const folder of folders) {
    if (outOfTime()) {
      catalogue.stoppedEarly = `deadline reached before folder ${folder}`;
      console.log(`\n!! deadline reached at ${elapsed()}, ${Object.keys(catalogue.folders).length}/${folders.length} folders done`);
      break;
    }
    try {
      const body = await fetchJson(`${ROOT}/${encodeURIComponent(folder)}?f=json`, REQ);
      const services = body.services || [];
      catalogue.folders[folder] = services;
      console.log(`\n--- ${folder}: ${services.length} service(s)  [${elapsed()}] ---`);
      for (const svc of services) {
        const flag = INTEREST.test(svc.name) ? ' <--' : '';
        console.log(`  ${svc.type.padEnd(12)} ${svc.name}${flag}`);
      }
    } catch (err) {
      catalogue.folders[folder] = { error: err.message.split('\n')[0] };
      console.log(`\n--- ${folder}: FAILED ${err.message.split('\n')[0].slice(0, 60)}  [${elapsed()}]`);
    }
    // After every folder, not at the end: a killed run should still leave behind what it
    // had already learned.
    writeDocument('geoportal', catalogue);
  }

  // The layers inside the services that look like they carry the country's water.
  // A MapServer's name is a hint; its layer list is the answer.
  const wanted = [];
  for (const services of Object.values(catalogue.folders)) {
    if (!Array.isArray(services)) continue;
    for (const svc of services) if (INTEREST.test(svc.name)) wanted.push(svc);
  }
  console.log(`\n--- layers inside ${wanted.length} candidate service(s)  [${elapsed()}] ---`);
  for (const svc of wanted) {
    if (outOfTime()) {
      catalogue.stoppedEarly = `deadline reached after ${Object.keys(catalogue.layers).length}/${wanted.length} services`;
      console.log(`!! deadline reached at ${elapsed()}`);
      break;
    }
    try {
      const body = await fetchJson(`${ROOT}/${svc.name}/${svc.type}?f=json`, REQ);
      const layers = (body.layers || []).map((l) => ({ id: l.id, name: l.name, type: l.geometryType || l.type }));
      catalogue.layers[svc.name] = { description: body.serviceDescription || body.description || null, layers };
      console.log(`  ${svc.name} (${layers.length} layer(s))`);
      for (const l of layers) console.log(`      ${String(l.id).padStart(3)}  ${l.name}`);
    } catch (err) {
      catalogue.layers[svc.name] = { error: err.message.split('\n')[0] };
      console.log(`  ${svc.name}  FAILED ${err.message.split('\n')[0].slice(0, 60)}`);
    }
    writeDocument('geoportal', catalogue);
  }

  console.log(`\ndone in ${elapsed()}${catalogue.stoppedEarly ? ` (INCOMPLETE: ${catalogue.stoppedEarly})` : ''}`);
  emitDocument('geoportal', catalogue, 'src/config/ (whatever turns out to be usable)');
}

/**
 * Soil moisture, asked of the drought network's own stations.
 *
 * This is the last thing the old caveat named that the site still could not measure. Two
 * routes to the official index are closed and closed cleanly:
 *
 *   - The HDI raster is an ArcGIS ImageServer that answers "Token Required" (error 499).
 *     It is not a public service, so it is not ours to read.
 *   - The settlement form on the front end returns the same numbers, and the site guards
 *     it with a hidden field its own source calls a bot trap. An operator does not build
 *     one of those by accident, and getting past it is not something to be clever about.
 *
 * The third route is open by construction. The drought service publishes its 127 stations
 * as a public GIS layer, and every one of them carries `HidrometTorzsszam` - the same
 * station identifier the vraquery API uses for everything else on this site. So the
 * question becomes one this project already knows how to ask: does that API serve a soil
 * moisture quantity at those particular stations?
 *
 * The earlier sweep found nothing between codes 62 and 90, but it asked the WRONG
 * STATIONS - the meteorological network, not these. That is the same mistake that had
 * talajvíz recorded as unpublished for weeks, so this time the stations come first.
 *
 * Many codes per request rather than many stations: one RequestTS entry carries its own
 * AdatFajtaKod, so a single POST can ask twelve stations about eight codes at once. An
 * unsupported code fails the whole request, so a failed chunk is retried code by code
 * rather than written off.
 */
async function probeDroughtSoil(args = []) {
  console.log('\n########## soil moisture at the drought network stations ##########');

  const GIS = 'https://geoportal.vizugy.hu/arcgis/rest/services/Aszalymon';
  const layer = await fetchJson(
    `${GIS}/Aszaly_monitoring_allomasok/MapServer/0/query?where=1%3D1&outFields=AllomasNev,HidrometTorzsszam&returnGeometry=false&f=json`,
    { timeoutMs: 30000 },
  );
  const stations = (layer.features || [])
    .map((f) => ({ name: f.attributes.AllomasNev, tsz: f.attributes.HidrometTorzsszam }))
    .filter((s) => Number.isFinite(s.tsz));
  console.log(`${stations.length} drought-monitoring stations with a Torzsszam`);
  if (!stations.length) return;

  const sample = stations.slice(0, 12);
  console.log(`asking ${sample.length} of them: ${sample.map((s) => `${s.name}(${s.tsz})`).slice(0, 5).join(' ')} ...`);

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86400000).toISOString();
  const end = new Date(now.getTime() + 3600000).toISOString();

  const range = (args.find((a) => a.startsWith('--codes=')) || '').slice(8);
  const CODES = range
    ? range.split(',').map(Number).filter(Number.isFinite)
    : Array.from({ length: 140 }, (_, i) => i + 1);

  const answered = [];
  const ask = async (codes, atCode) => {
    const body = [];
    for (const [ci, code] of codes.entries()) {
      for (const [si, st] of sample.entries()) {
        body.push({
          ItemId: ci * sample.length + si,
          Torzsszam: Number(st.tsz),
          AdatFajtaKod: code,
          AdatTipusKod: atCode,
          StartTime: start,
          EndTime: end,
        });
      }
    }
    const out = await askSeries(body, { timeoutMs: 60000 });
    const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
    for (const [ci, code] of codes.entries()) {
      const hits = [];
      for (const [si, st] of sample.entries()) {
        const items = usable(byItemId.get(ci * sample.length + si));
        if (items.length) hits.push({ st, items });
      }
      if (!hits.length) continue;
      const last = hits[0].items[hits[0].items.length - 1];
      const values = hits.map((h) => Number(h.items[h.items.length - 1].Adat)).filter(Number.isFinite).sort((a, b) => a - b);
      answered.push({ code, atCode, stations: hits.length, sampleStation: hits[0].st.name,
        samples: hits[0].items.length, last: last.UTCTime, min: values[0], max: values[values.length - 1],
        median: values[Math.floor(values.length / 2)] });
      console.log(
        `  code ${String(code).padStart(3)} / type ${String(atCode).padStart(3)}: ` +
          `${String(hits.length).padStart(2)}/${sample.length} stations  ` +
          `${String(hits[0].items.length).padStart(4)} samples  last ${last.UTCTime.slice(0, 16)}  ` +
          `values ${values[0]} .. ${values[values.length - 1]} (median ${values[Math.floor(values.length / 2)]})`,
      );
    }
  };

  for (const atCode of [100, 2]) {
    console.log(`\n--- AdatTipusKod ${atCode} ---`);
    for (let i = 0; i < CODES.length; i += 8) {
      const chunk = CODES.slice(i, i + 8);
      try {
        await ask(chunk, atCode);
      } catch {
        // One unsupported code fails the batch, so the batch is worth retrying singly
        // rather than discarding seven codes that might have answered.
        for (const code of chunk) {
          try { await ask([code], atCode); } catch { /* genuinely unsupported */ }
        }
      }
    }
  }

  console.log(`\n${answered.length} (code, type) pair(s) answered at these stations`);
  emitDocument('drought-soil', { stations: stations.length, asked: sample, answered },
    'src/config/aszaly-soil.json (after review)');
}

/**
 * Is there a real drought measurement to be had, or only a rainfall ratio?
 *
 * The site currently says, in its own words, "not an official drought index - a real one
 * looks at soil moisture and the rainfall deficit". That sentence is honest and it is
 * also an admission: the page grades a drought on rain alone, which is the one input
 * that says how much water ARRIVED and nothing about how much is left in the ground.
 * Two Augusts with the same rainfall are different droughts if one followed a wet spring.
 *
 * Hungary has an official answer - the Aszálymonitoring service run by OVF and NAK,
 * which publishes a Hungarian Drought Index built from soil moisture, temperature and
 * precipitation. The question this probe asks is whether any of that is reachable as
 * data rather than as a picture of a map.
 *
 * Three places it could be, asked in order of how usable the answer would be:
 *
 *   1. The same vraquery API everything else here comes from, under a station network
 *      (vmoType) or a quantity code (AdatFajtaKod) nobody has asked for yet.
 *   2. aszalymonitoring.vizugy.hu, as an endpoint behind its own front end.
 *   3. Nowhere, in which case the honest thing is to keep saying so.
 */
async function probeDrought(args = []) {
  console.log('\n########## drought: soil moisture and the official index ##########');

  // --- 1. Which station networks exist at all -------------------------------------
  //
  // Only 11 (surface), 13 (wells) and 14 (meteorological) have ever been asked for. The
  // numbering is a small integer with no published list, so the cheapest way to find a
  // soil-moisture network is to walk it and look at what comes back.
  console.log('\n--- station networks (vmoType) ---');
  const networks = [];
  for (let vmoType = 1; vmoType <= 24; vmoType += 1) {
    try {
      const { rows } = await fetchCatalogue(vmoType, { internetOnly: true });
      if (!Array.isArray(rows) || !rows.length) {
        console.log(`  ${String(vmoType).padStart(2)}  empty`);
        continue;
      }
      const sample = rows[0];
      console.log(
        `  ${String(vmoType).padStart(2)}  ${String(rows.length).padStart(4)} stations` +
          `  e.g. ${String(sample.Nev || sample.Telepules || '?').slice(0, 30).padEnd(30)}` +
          `  fields: ${Object.keys(sample).join(',')}`,
      );
      networks.push({ vmoType, rows });
    } catch (err) {
      console.log(`  ${String(vmoType).padStart(2)}  FAILED ${err.message.split('\n')[0].slice(0, 60)}`);
    }
  }

  // --- 2. Which quantity codes answer on the met network ---------------------------
  //
  // 71 (rainfall) is the only code ever asked of vmoType 14, and a met station that
  // measures rain usually measures more. A soil moisture series would be the whole
  // feature; air temperature would at least let a deficit be weighted by evaporation
  // demand, which is what turns "little rain" into "drought".
  const met = networks.find((n) => n.vmoType === 14);
  if (met) {
    console.log(`\n--- quantity codes on vmoType 14, ${Math.min(met.rows.length, 12)} stations, 30 days ---`);
    const stations = met.rows.filter((r) => r.Tsz).slice(0, 12);
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 86400000).toISOString();
    const end = new Date(now.getTime() + 3600000).toISOString();

    // A wide sweep rather than a guess. The catalogue numbers quantities in the high
    // 60s to low 80s (69 talajvíz, 70 rétegvíz, 71 csapadék, 81 vízhőmérséklet), so the
    // neighbourhood is where a soil-moisture or air-temperature code would live.
    const codeArg = (args.find((a) => a.startsWith('--codes=')) || '').slice(8);
    const CODES = codeArg
      ? codeArg.split(',').map(Number).filter(Number.isFinite)
      : [62, 63, 64, 65, 66, 67, 68, 72, 73, 74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 86, 88, 89, 90];

    for (const code of CODES) {
      for (const atCode of [100, 2]) {
        try {
          const out = await askSeries(
            stations.map((s, i) => ({
              ItemId: i,
              Torzsszam: Number(s.Tsz),
              AdatFajtaKod: code,
              AdatTipusKod: atCode,
              StartTime: start,
              EndTime: end,
            })),
            { timeoutMs: 45000 },
          );
          const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
          let answered = 0;
          let sample = null;
          stations.forEach((s, i) => {
            const items = usable(byItemId.get(i));
            if (!items.length) return;
            answered += 1;
            if (!sample) sample = { name: s.Nev, last: items[items.length - 1], n: items.length };
          });
          if (answered) {
            console.log(
              `  code ${String(code).padStart(3)} / type ${String(atCode).padStart(3)}: ` +
                `${answered}/${stations.length} answered  e.g. ${String(sample.name).slice(0, 22).padEnd(22)} ` +
                `${String(sample.n).padStart(4)} samples  last ${sample.last.UTCTime.slice(0, 16)} = ${sample.last.Adat}`,
            );
          }
        } catch {
          // A code the service does not know fails the whole request; that is a negative
          // result, not an error worth a line each.
        }
      }
    }
    console.log('  (codes with no line answered nowhere)');
  }

  // --- 2b. The network nobody had asked for ----------------------------------------
  //
  // The sweep above turned up vmoType 12 with 2030 stations, more than any other network
  // here, carrying the same `Npt` datum field the groundwater wells do. Only 11, 13 and
  // 14 had ever been requested, so this has been sitting there the whole time.
  //
  // If it is the shallow water-table network it is the most important thing on this page
  // that is currently missing: talajvíz is what a garden well reaches and what a maize
  // root system drinks, it is the standing negative result of this project so far
  // (AdatFajtaKod 69 answered nowhere on vmoType 13), and it is half of what makes a
  // drought a drought rather than a dry month.
  const twelve = networks.find((n) => n.vmoType === 12);
  if (twelve) {
    console.log(`\n--- vmoType 12: ${twelve.rows.length} stations, what do they publish? ---`);
    console.log(`  sample rows: ${twelve.rows.slice(0, 4).map((r) => `${r.Tsz}:${r.Nev}`).join('  |  ')}`);

    const stations = twelve.rows.filter((r) => r.Tsz && r.Lat != null).slice(0, 40);
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 86400000).toISOString();
    const end = new Date(now.getTime() + 3600000).toISOString();

    for (const [code, label] of [[69, 'talajvízállás'], [70, 'rétegvízszint'], [71, 'csapadék'], [68, 'vízállás']]) {
      for (const atCode of [100, 2, 6, 1]) {
        try {
          const out = await askSeries(
            stations.map((s, i) => ({
              ItemId: i,
              Torzsszam: Number(s.Tsz),
              AdatFajtaKod: code,
              AdatTipusKod: atCode,
              StartTime: start,
              EndTime: end,
            })),
            { timeoutMs: 60000 },
          );
          const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(out) ? out : []);
          const live = [];
          stations.forEach((s, i) => {
            const items = usable(byItemId.get(i));
            if (items.length) live.push({ s, items });
          });
          if (!live.length) continue;

          const values = live.map((l) => Number(l.items[l.items.length - 1].Adat))
            .filter(Number.isFinite).sort((a, b) => a - b);
          console.log(
            `  ${code}/${atCode}  ${label.padEnd(14)} ${String(live.length).padStart(3)}/${stations.length} answered  ` +
              `values ${values[0]} .. ${values[values.length - 1]} (median ${values[Math.floor(values.length / 2)]})`,
          );
          for (const l of live.slice(0, 3)) {
            const last = l.items[l.items.length - 1];
            console.log(
              `        ${String(l.s.Tsz).padEnd(7)} ${String(l.s.Nev).slice(0, 24).padEnd(24)} ` +
                `npt ${String(l.s.Npt).padStart(7)}  ${String(l.items.length).padStart(4)} samples  ` +
                `last ${last.UTCTime.slice(0, 16)} = ${last.Adat}`,
            );
          }
        } catch {
          // Unsupported pair; the absence of a line is the result.
        }
      }
    }
  }

  // --- 3. The official drought service ---------------------------------------------
  //
  // Its front end is a map, so the useful question is what the map fetches. Same method
  // as the original vizugy discovery: read the bundle for the URLs it calls.
  console.log('\n--- aszalymonitoring.vizugy.hu ---');
  for (const url of [
    'https://aszalymonitoring.vizugy.hu/',
    'https://aszalymonitoring.vizugy.hu/index.php',
    'https://aszalymonitoring.vizugy.hu/api/',
  ]) {
    try {
      const res = await fetchText(url, { timeoutMs: 20000 });
      const body = typeof res === 'string' ? res : res.body;
      const type = typeof res === 'string' ? '?' : res.contentType;
      console.log(`  OK   ${url}  ${type}  ${body.length} bytes`);
      // Endpoint-shaped strings in whatever it served.
      const hits = new Set();
      for (const m of body.matchAll(/["'`]([^"'`\s]*\/(?:api|ajax|json|data|service|wms|wfs)[^"'`\s]*)["'`]/gi)) {
        hits.add(m[1]);
      }
      for (const m of body.matchAll(/["'`]([^"'`\s]+\.(?:json|php|ashx))(?:\?[^"'`\s]*)?["'`]/gi)) hits.add(m[1]);
      const list = [...hits].slice(0, 25);
      if (list.length) {
        console.log(`       ${list.length} candidate endpoint(s):`);
        for (const hit of list) console.log(`         ${hit}`);
      } else {
        console.log('       no endpoint-shaped strings in the response');
      }

      // It serves 26 KB of server-rendered HTML with one endpoint in it, which means it
      // is not a front end calling an API - so if the numbers exist at all they are IN
      // this document. Look for them rather than concluding from the absence of a JSON
      // route that there is nothing here.
      const tables = (body.match(/<table/gi) || []).length;
      const options = [...body.matchAll(/<option[^>]*value=["']([^"']+)["'][^>]*>([^<]*)</gi)].slice(0, 12);
      const numbers = [...body.matchAll(/>\s*(-?\d+[.,]\d+)\s*</g)].slice(0, 12).map((m) => m[1]);
      const forms = [...body.matchAll(/<form[^>]*action=["']([^"']*)["'][^>]*>/gi)].map((m) => m[1]);
      const inputs = [...body.matchAll(/<(?:input|select)[^>]*name=["']([^"']+)["']/gi)].map((m) => m[1]);
      console.log(`       ${tables} table(s), ${options.length} option(s), ${numbers.length} decimal(s) in text nodes`);
      if (forms.length) console.log(`       form action(s): ${[...new Set(forms)].join(', ')}`);
      if (inputs.length) console.log(`       form field(s): ${[...new Set(inputs)].slice(0, 20).join(', ')}`);
      if (options.length) console.log(`       options: ${options.map((m) => `${m[1]}=${m[2].trim().slice(0, 18)}`).join(' | ')}`);
      if (numbers.length) console.log(`       decimals: ${numbers.join(' ')}`);
      // Whatever it calls the index, in its own words.
      for (const term of ['HDI', 'aszályindex', 'talajnedvesség', 'Aszályindex']) {
        const at = body.indexOf(term);
        if (at >= 0) console.log(`       "${term}" at ${at}: ${body.slice(at - 60, at + 120).replace(/\s+/g, ' ')}`);
      }
    } catch (err) {
      console.log(`  FAIL ${url}  ${err.message.split('\n')[0].slice(0, 70)}`);
    }
  }
}

async function probeMatrix() {
  console.log('\n########## kind x type matrix ##########');

  const STATIONS = [
    [468, 'Ólmod K-2 (well, had 70)'],
    [3726, 'Debrecen-Józsa (well, had 70)'],
    [4196, 'Monor K-209 (well, empty)'],
    [4445, 'Jászszentlászló (rain)'],
    [1026, 'Budapest (surface, control)'],
  ];
  const KINDS = [69, 70, 71, 297, 299, 307, 308];
  const TYPES = [1, 4, 5, 6, 9, 15, 100, 101];

  const now = new Date();
  const start = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString();
  const end = new Date(now.getTime() + 3600 * 1000).toISOString();

  console.log(`stations: ${STATIONS.map(([tsz, label]) => `${tsz} ${label}`).join(' | ')}`);
  console.log(`\n  ${'kind'.padEnd(5)} ${'type'.padEnd(5)} ${STATIONS.map(([tsz]) => String(tsz).padStart(9)).join('')}`);

  for (const haf of KINDS) {
    for (const at of TYPES) {
      const body = STATIONS.map(([tsz], index) => ({
        ItemId: index,
        Torzsszam: tsz,
        AdatFajtaKod: haf,
        AdatTipusKod: at,
        StartTime: start,
        EndTime: end,
      }));

      let cells;
      try {
        const rows = await askSeries(body, { timeoutMs: 20000 });
        const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(rows) ? rows : []);
        cells = STATIONS.map((_, index) => {
          const items = usable(byItemId.get(index));
          return String(items.length || '.').padStart(9);
        }).join('');
      } catch (err) {
        cells = `  ${String(err.message).slice(0, 40)}`;
      }

      // Only the rows with something in them; 56 lines of dots is not a result.
      if (!/^(\s+\.)+$/.test(cells)) console.log(`  ${String(haf).padEnd(5)} ${String(at).padEnd(5)} ${cells}`);
    }
  }

  console.log('\n(a dot is an empty series, a number is how many non-null samples came back)');
}

/**
 * Rain gauges: what exists, and what the units are.
 *
 * vmoType 14 is the meteorological network. 71 is "csapadékösszeg" in millimetres, but a
 * sum is a sum over something - if the series is hourly then a month's total is a sum of
 * 720 values, and if it is daily then adding hourly-shaped assumptions to it inflates the
 * total by an order of magnitude. The sample spacing in the output settles it, which is
 * why the window here is long enough to see the spacing rather than one value.
 */
async function probeRain() {
  console.log('\n########## precipitation (vmoType 14) ##########');

  let rows = [];
  for (const internetOnly of [true, false]) {
    try {
      const res = await fetchCatalogue(14, { internetOnly });
      console.log(`${res.url}: ${Array.isArray(res.rows) ? res.rows.length : 'not an array'} entries`);
      if (internetOnly && Array.isArray(res.rows)) rows = res.rows;
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
  }
  if (!rows.length) return;

  console.log(`\nOne record, in full:\n${JSON.stringify(rows[0], null, 2)}`);

  const byVizig = new Map();
  for (const row of rows) byVizig.set(row.Vizig, (byVizig.get(row.Vizig) || 0) + 1);
  console.log(`\nstations per directorate: ${[...byVizig].map(([v, n]) => `${v}:${n}`).join('  ')}`);

  const sample = [];
  for (const [vizig] of byVizig) {
    const pick = rows.find((r) => r.Vizig === vizig && r.Lat != null && r.Lon != null);
    if (pick) sample.push(pick);
  }
  console.log(`\nAsking ${sample.length} stations, one per directorate, 30 days:`);

  const now = new Date();
  const start = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

  for (const [haf, label] of [[71, 'csapadékösszeg mm'], [105, 'csapadékintenzitás mm/h'], [81, 'léghőmérséklet °C']]) {
    console.log(`\n--- AdatFajtaKod ${haf} (${label}) ---`);
    try {
      const rowsOut = await askSeries(
        sample.map((station, index) => ({
          ItemId: index,
          Torzsszam: Number(station.Tsz),
          AdatFajtaKod: haf,
          AdatTipusKod: 100,
          StartTime: start,
          EndTime: new Date(now.getTime() + 3600 * 1000).toISOString(),
        })),
      );
      const byItemId = require('../sources/vizugy').indexByItemId(Array.isArray(rowsOut) ? rowsOut : []);
      sample.forEach((station, index) => {
        const items = usable(byItemId.get(index));
        const total = items.reduce((sum, i) => sum + Number(i.Adat), 0);
        console.log(
          `  Tsz ${String(station.Tsz).padEnd(8)} ${String(station.Nev).slice(0, 26).padEnd(26)} ` +
            `${station.Vizig}  ${describeSeries(items, now)}` +
            (haf === 71 && items.length ? `  sum=${total.toFixed(1)}` : ''),
        );
      });
      // The spacing is the whole question for a "sum" series.
      const firstWithData = sample.map((_, i) => usable(byItemId.get(i))).find((items) => items.length > 2);
      if (firstWithData) {
        const gaps = firstWithData
          .slice(1, 6)
          .map((item, i) => (new Date(item.UTCTime) - new Date(firstWithData[i].UTCTime)) / 60000);
        console.log(`  sample spacing, first few: ${gaps.join(', ')} minutes`);
        console.log(`  first five: ${firstWithData.slice(0, 5).map((i) => `${i.UTCTime.slice(0, 16)}=${i.Adat}`).join('  ')}`);
      }
    } catch (err) {
      console.log(`  FAILED: ${err.message}`);
    }
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

  if (args.includes('--forecast')) {
    await probeForecast();
    return;
  }

  if (args.includes('--groundwater')) {
    await probeGroundwater();
    return;
  }

  if (args.includes('--rain')) {
    await probeRain();
    return;
  }

  if (args.includes('--unit-history')) {
    await probeUnitHistory(args);
    return;
  }

  if (args.includes('--geoportal')) {
    await probeGeoportal(args);
    return;
  }

  if (args.includes('--waters')) {
    await probeWaters(args);
    return;
  }

  if (args.includes('--sewage')) {
    await probeSewage(args);
    return;
  }

  if (args.includes('--uwwtd')) {
    await probeUwwtd(args);
    return;
  }

  if (args.some((a) => a.startsWith('--layer='))) {
    await probeLayer(args);
    return;
  }

  if (args.includes('--drought-soil')) {
    await probeDroughtSoil(args);
    return;
  }

  if (args.includes('--drought-index')) {
    await probeDroughtIndex(args);
    return;
  }

  if (args.includes('--drought')) {
    await probeDrought(args);
    return;
  }

  if (args.includes('--matrix')) {
    await probeMatrix();
    return;
  }

  if (args.includes('--rain-scan')) {
    await probeRainScan();
    return;
  }

  if (args.includes('--vmo-scan')) {
    await probeVmoScan(args);
    return;
  }

  if (args.includes('--soil-history')) {
    await probeSoilHistory(args);
    return;
  }

  if (args.includes('--well-scan')) {
    await probeWellScan(args);
    return;
  }

  if (args.includes('--rain-normals')) {
    await probeRainNormals();
    return;
  }

  if (args.includes('--flow-history')) {
    await probeFlowHistory(args);
    return;
  }

  if (args.includes('--lake-history')) {
    await probeLakeHistory(args);
    return;
  }

  if (args.includes('--well-history')) {
    await probeWellHistory(args);
    return;
  }

  if (args.includes('--operations')) {
    await probeOperations();
    return;
  }

  if (args.includes('--mavir-charts')) {
    await probeMavirCharts();
    return;
  }

  if (args.includes('--mavir-sheet')) {
    await probeMavirSheet(args);
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

  // An unrecognised flag must not mean "do everything".
  //
  // Every branch above returns, so reaching here with arguments in hand means none of
  // them named an action - and the default was to run the full discovery sweep against
  // both upstreams. A single typo therefore cost MAVIR twenty requests and earned a 429
  // across the whole host, which is how `--deployed` (a flag this CLI never had) turned
  // into a rate-limit. Someone else's public service should not pay for our spelling.
  const ACTIONS = new Set(['--vizugy', '--mavir', '--discover', '--portal']);
  if (args.length && !args.some((a) => ACTIONS.has(a))) {
    console.error(`Unrecognised probe arguments: ${args.join(' ')}`);
    console.error(
      '\nActions: --live --vizugy --mavir --discover --portal --thresholds --lakes --datatypes\n' +
      '         --forecast --groundwater --rain --matrix --rain-scan --well-scan --rain-normals\n' +
      '         --flow-history --lake-history --well-history --drought --drought-index\n' +
      '         --drought-soil --geoportal --waters --sewage --uwwtd\n' +
      '         --layer=URL [--fetch] [--where=] [--out=NAME]\n' +
      '         --unit-history\n' +
      '         --operations\n' +
      '         --mavir-charts\n' +
      '         --mavir-sheet --entsoe --find=NAME --url=URL --page=URL --site=BASEURL\n' +
      '\nRefusing to fall back to the full sweep: it is dozens of requests against two\n' +
      'public services, and a typo is not a reason to spend them.',
    );
    process.exitCode = 2;
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
