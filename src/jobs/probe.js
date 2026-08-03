'use strict';

const { fetchText } = require('../lib/http');
const { describeShape } = require('../lib/jsonpath');
const vizugy = require('../sources/vizugy');
const mavir = require('../sources/mavir');

/**
 * Endpoint discovery tool.
 *
 * The two upstream services could not be reached from the environment this project was
 * written in, so their exact paths and response shapes are configuration rather than
 * hard-coded assumptions. This script is how you close that gap: run it from a machine
 * that can reach them, read what it prints, and set the matching environment variables.
 *
 *   node src/jobs/probe.js --vizugy
 *   node src/jobs/probe.js --mavir
 *   node src/jobs/probe.js --url https://data.vizugy.hu/some/path
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

  const doAll = args.length === 0;

  if (doAll || args.includes('--vizugy')) {
    const cfg = vizugy.config();
    console.log('\n########## data.vizugy.hu ##########');
    console.log(`Configured base: ${cfg.baseUrl}`);
    console.log(`Configured path: ${cfg.path}`);
    console.log('\nNOTE: this path is a placeholder. Open the portal in a browser, watch the');
    console.log('network tab while a station chart loads, and probe the URL it calls.');

    await probeUrl(cfg.baseUrl, 'portal root');
    const sampleStation = { id: 'duna-rajka' };
    await probeUrl(vizugy.buildUrl(cfg, sampleStation), 'guessed station endpoint');
  }

  if (doAll || args.includes('--mavir')) {
    const cfg = mavir.config();
    console.log('\n########## mavir.hu ##########');
    console.log(`Configured base: ${cfg.baseUrl}`);
    console.log(`Configured path: ${cfg.path} (chartId=${cfg.chartId})`);

    const payload = await probeUrl(mavir.buildUrl(cfg), 'guessed chart endpoint');
    if (payload) {
      const parsed = mavir.parseGeneration(payload, cfg);
      console.log('\nParsed generation mix:');
      console.log(parsed ? JSON.stringify(parsed, null, 2) : '  (no recognisable series - check SERIES_ALIASES)');
    }
  }

  console.log('\nDone. Record what worked in .env, then run `npm run poll` to verify the ingest.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { probeUrl };
