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
    ['rainfall', '/api/v1/rainfall?days=30', (d) => {
      const gauges = Object.keys(d.gauges || {}).length;
      return { ok: gauges > 0, note: `${gauges} gauges` };
    }],
    // /archive, not /api/v1/archive: it is mounted outside the API version on purpose,
    // because a dated URL published today has to still resolve in ten years and /api/v1
    // is a promise about a response shape rather than about permanence. Probing the
    // versioned path reported a 404 against a perfectly healthy endpoint - a check that
    // cries wolf is worse than no check, because the next real failure gets ignored.
    ['archive', '/archive', (d) => ({
      ok: Array.isArray(d.days) ? d.days.length > 0 : Boolean(d),
      note: Array.isArray(d.days) ? `${d.days.length} days` : 'responded',
    })],
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
function emitDocument(name, doc, destination) {
  const file = writeDocument(name, doc);
  const json = JSON.stringify(doc);
  if (file) console.log(`\nwrote ${file} (${json.length} bytes) - download it from the run's artifacts`);
  // One line, deliberately: pretty-printing turns 30 stations into two thousand.
  console.log(`\n----- paste into ${destination} -----`);
  console.log(json);
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

        for (const [day, bucket] of byDay) {
          const month = Number(day.slice(5, 7)) - 1;
          if (daysInMonth[month] < MIN_DAYS_IN_MONTH) continue;
          const mean = bucket.sum / bucket.n;
          perMonth[month].push(mean);
          yearsIn[month].add(year);
          const ex = extremes[month];
          if (ex.min === null || mean < ex.min.value) ex.min = { value: round2(mean), year, day };
          if (ex.max === null || mean > ex.max.value) ex.max = { value: round2(mean), year, day };
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
  }

  console.log('\npercentiles are [5 10 25 50 75 90 95] of daily mean level, cm on the gauge datum');
  emitDocument('lake-history', out, 'src/config/lake-history.json');
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
  console.log('\n########## groundwater history ##########');
  const { listWells, WELL_KIND } = require('../config/wells');
  const arg = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };

  const only = (arg('only') || '').split(',').filter(Boolean);
  const wells = listWells().filter((w) => !only.length || only.includes(w.id));
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
    writeDocument('well-history', out);
  }

  const rankable = Object.values(out).filter((e) => e.rankable).length;
  console.log(`\n${Object.keys(out).length}/${wells.length} wells have a usable record, ${rankable} of them rankable`);
  console.log('percentiles are [5 10 25 50 75 90 95] of daily mean depth against each well\'s own datum,');
  console.log('in whatever unit that well reports - which is why nothing here may be averaged across wells');
  emitDocument('well-history', out, 'src/config/well-history.json');
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
      '         --flow-history --lake-history --well-history --drought --unit-history\n' +
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
