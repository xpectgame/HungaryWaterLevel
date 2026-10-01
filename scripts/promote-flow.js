#!/usr/bin/env node
'use strict';

/**
 * Promote a discharge-archive bake into src/config - but only if it is sane.
 *
 *     node scripts/promote-flow.js [bakeDir=probe-out] [configDir=src/config]
 *
 * Used by the scheduled refresh workflow. A daily job that copies whatever the probe left
 * behind would, on the morning vizugy.hu is down, replace a good archive with a stale or
 * half-empty one and nobody would notice until a reader did. So the bake has to prove it
 * is current before it is allowed anywhere near the deployment:
 *
 *   - flow-daily.json: at least MIN_STATIONS gauges, and at least MIN_STATIONS of them with
 *     a day inside the last FRESH_WITHIN_DAYS days. An archive that did not move is a
 *     failed refresh, and a failed refresh must fail the run, loudly.
 *   - flow-yearly.json: at least MIN_STATIONS gauges.
 *   - flow-history.json: only written by the monthly full bake; when present, at least
 *     MIN_STATIONS gauges with their twelve-month envelopes.
 *
 * Exits non-zero, copying nothing, if any check fails.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIN_STATIONS = 20; // of ~28 mapped gauges
const FRESH_WITHIN_DAYS = 5;

const [bakeDir = 'probe-out', configDir = 'src/config'] = process.argv.slice(2);

function load(name) {
  const file = path.join(bakeDir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** The newest real day for one gauge - future-dated keys (the "12-31" spill) ignored. */
function lastDay(byYear, today) {
  let last = null;
  for (const [year, days] of Object.entries(byYear || {})) {
    for (const [md, v] of Object.entries(days || {})) {
      const iso = `${year}-${md}`;
      if (!Number.isFinite(v) || iso > today) continue;
      if (!last || iso > last) last = iso;
    }
  }
  return last;
}

const now = new Date();
const today = now.toISOString().slice(0, 10);
const cutoff = new Date(now.getTime() - FRESH_WITHIN_DAYS * 86400000).toISOString().slice(0, 10);
const problems = [];

const daily = load('flow-daily.json');
if (!daily) {
  problems.push('flow-daily.json is missing from the bake');
} else {
  const ids = Object.keys(daily);
  const fresh = ids.filter((id) => (lastDay(daily[id], today) || '') >= cutoff);
  if (ids.length < MIN_STATIONS) problems.push(`flow-daily.json has ${ids.length} gauges (< ${MIN_STATIONS})`);
  if (fresh.length < MIN_STATIONS) {
    problems.push(`only ${fresh.length} gauges in flow-daily.json have a day since ${cutoff} (< ${MIN_STATIONS})`);
  }
  console.log(`flow-daily:   ${ids.length} gauges, ${fresh.length} current (a day since ${cutoff})`);
}

const yearly = load('flow-yearly.json');
if (!yearly || Object.keys(yearly).length < MIN_STATIONS) {
  problems.push(`flow-yearly.json has ${yearly ? Object.keys(yearly).length : 0} gauges (< ${MIN_STATIONS})`);
} else {
  console.log(`flow-yearly:  ${Object.keys(yearly).length} gauges`);
}

const history = load('flow-history.json');
if (history) {
  const withEnvelopes = Object.values(history).filter((e) => e && Array.isArray(e.months)).length;
  if (withEnvelopes < MIN_STATIONS) problems.push(`flow-history.json has ${withEnvelopes} gauges with envelopes (< ${MIN_STATIONS})`);
  else console.log(`flow-history: ${withEnvelopes} gauges with monthly envelopes`);
}

if (problems.length) {
  console.error(`refusing to promote the bake:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

for (const name of ['flow-daily.json', 'flow-yearly.json', 'flow-history.json']) {
  const src = path.join(bakeDir, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(configDir, name));
    console.log(`promoted ${name}`);
  }
}
