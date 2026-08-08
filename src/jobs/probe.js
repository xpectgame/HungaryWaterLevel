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

  // The two calls the portal itself makes, so their exact shapes are the ones needed.
  console.log('\nSchemas for the time-series call:');
  for (const name of ['TsQuery', 'TsRequest', 'TsShortListRequest', 'TsItem', 'TsShortList']) {
    for (const line of describeSchema(spec, name)) console.log(`  ${line}`);
    console.log('');
  }

  return spec;
}

/**
 * Fetch the station catalogue and line it up against the registry.
 *
 * This is what produces EXTERNAL_IDS. A wrong identifier here does not fail - it
 * reports a different river under a station's name and the balance stays plausible,
 * so the matcher checks the coordinates as well as the name and labels its confidence.
 */
async function probeCatalogue(vmoType = 11) {
  console.log(`\n########## station catalogue (vmoType ${vmoType}) ##########`);

  const url = `${VRAQUERY_BASE}/Vra/InternetVmo/${vmoType}/false`;
  console.log(`GET ${url}`);

  try {
    const token = await createTokenProvider().getToken();
    const rows = await fetchJson(url, {
      timeoutMs: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        ...browserHeaders('https://data.vizugy.hu'),
      },
    });

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

async function main() {
  const args = process.argv.slice(2);

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
    console.log(`Currently configured: ${cfg.baseUrl}${cfg.path}`);

    // The endpoints are no longer in question. The portal's bundle gave up the auth
    // flow and the two calls it makes, and the swagger initialiser named the OpenAPI
    // document. So the default run reads the contract and the catalogue rather than
    // re-mining megabytes of minified code; `--discover` still does the mining when
    // something upstream changes and the contract stops matching.
    await probeOpenApi();
    await probeCatalogue(11);

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
    console.log(`Currently configured: ${cfg.baseUrl}${cfg.path}`);

    // The real-time figures live on their own page; its bundles are the ones that know
    // where the data comes from.
    for (const page of [
      'https://www.mavir.hu/web/mavir/rendszerterheles',
      'https://www.mavir.hu/web/mavir/valos-ideju-aggregalt-termeles',
    ]) {
      await discover(page);
    }

    // Discovery found the charts are an iframe into a separate application on its own
    // host. tab4402 is the real-time generation mix - the series this project needs -
    // and tab7679 is system load. Probed directly so a transport failure is reported
    // with its cause rather than as a bare "fetch failed" inside the recursion.
    // The publication app itself answers - only the chart servlet timed out - so mine
    // its own scripts. That is the application that actually holds the data endpoints.
    // rtdwweb.mavir.hu answered once and has since only timed out from this runner,
    // which reads as datacentre-IP throttling rather than an outage. From a Hungarian
    // connection it responds - so run `npm run probe -- --mavir` locally if this fails.
    console.log('\n########## mavir publication app ##########');
    await discover('https://rtdwweb.mavir.hu/rtdwweb/webuser/', {
      keywords: ['getData', 'DataServlet', 'tabId', 'ajax', 'json'],
    });
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
