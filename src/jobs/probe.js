'use strict';

const { fetchText } = require('../lib/http');
const { describeShape } = require('../lib/jsonpath');
const vizugy = require('../sources/vizugy');
const mavir = require('../sources/mavir');
const { discover } = require('./discover');
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

async function probeUrl(url, label) {
  console.log(`\n=== ${label || url} ===`);
  console.log(`GET ${url}`);

  try {
    const { body, contentType } = await fetchText(url, { timeoutMs: 20000, retries: 0 });
    console.log(`content-type: ${contentType}`);
    console.log(`length: ${body.length} bytes`);

    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      console.log('Not JSON. First 400 characters:\n');
      console.log(trimmed.slice(0, 400));
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
    await discover(cfg.baseUrl);

    // The portal's bundles point at vmservice.vizugy.hu/vraquery - the hydrological
    // database's own query service, which publishes documentation next to itself. The
    // contract is written down; reading it beats probing paths blind.
    await fetchDocs([
      'https://vmservice.vizugy.hu/vmhelp/',
      'https://vmservice.vizugy.hu/vmhelp/Funkcioleiras.html',
      'https://vmservice.vizugy.hu/vmhelp/Katalogustaroltnapiadatoklekerde.html',
      'https://vmservice.vizugy.hu/vmhelp/Hidrometeorologiaiadatok.html',
    ]);
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
    console.log('\n########## mavir chart application ##########');
    for (const url of [
      'https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab4402',
      'https://rtdwweb.mavir.hu/rtdwweb/webuser/GenerateChartsServlet?hunLang=hu-hu&tabId=tab7679',
      'https://rtdwweb.mavir.hu/rtdwweb/webuser/',
      'https://rtdwweb.mavir.hu/',
    ]) {
      await probeUrl(url, url.replace('https://rtdwweb.mavir.hu', ''));
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
