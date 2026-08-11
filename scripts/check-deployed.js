#!/usr/bin/env node
'use strict';

/**
 * Is the deployed site actually working, and which upstreams is it really reaching?
 *
 * This exists because "I added the token, what's wrong?" cannot be answered from a
 * development sandbox: its egress is policy-filtered and hovafolyik.hu is not on the
 * allowlist, so the site is unreachable from where the code is written. A GitHub runner
 * can reach it, so the check runs there.
 *
 * The thing it is really testing is not "does the API return 200" - a deployment with no
 * ENTSO-E token returns 200 all day, with `basis: "inferred"` quietly standing in for
 * measured unit data. That substitution is deliberate and correct at runtime; it is also
 * exactly what makes a missing token invisible. So this asks the questions that
 * distinguish configured from working:
 *
 *   - is it serving real data, or the fixture?
 *   - how old is the newest reading?
 *   - did any upstream error on the last poll?
 *   - is any plant's unit count on a MEASURED basis, or is every one of them inferred?
 *
 * The last one is the ENTSO-E answer. A73 is the only source of per-unit output, so if no
 * plant reports a measured basis, the token is absent, wrong, or scoped to the wrong
 * Vercel environment - regardless of what the dashboard says is set.
 *
 *   node scripts/check-deployed.js [https://www.hovafolyik.hu]
 */

const BASE = (process.argv[2] || process.env.SITE_URL || 'https://www.hovafolyik.hu').replace(/\/$/, '');

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${path} -> not JSON: ${body.slice(0, 200)}`);
  }
}

function line(ok, label, detail) {
  console.log(`  ${ok === null ? '·' : ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  console.log(`\nchecking ${BASE}\n`);
  const problems = [];

  const health = await get('/api/v1/health');
  const live = health.provider && health.provider !== 'fixture';
  line(live, `provider = ${health.provider}`, health.synthetic ? 'SYNTHETIC DATA' : 'real upstream');
  if (!live) problems.push('the deployment is serving fixture data');

  const ageMin = Math.round((health.dataAgeSeconds || 0) / 60);
  const fresh = health.dataAgeSeconds != null && health.dataAgeSeconds < 3 * 3600;
  line(fresh, `newest reading is ${ageMin} min old`);
  if (!fresh) problems.push(`data is ${ageMin} minutes old`);

  const errors = (health.lastPoll && health.lastPoll.errors) || health.upstreamErrors || [];
  line(errors.length === 0, `${errors.length} upstream error(s) on the last poll`,
    errors.length ? JSON.stringify(errors).slice(0, 300) : '');
  if (errors.length) problems.push(`${errors.length} upstream error(s)`);

  // --- the ENTSO-E question -------------------------------------------------
  const snapshot = await get('/api/v1/snapshot');
  const plants = (snapshot.power && snapshot.power.plants) || [];
  // `units` is null outright when nothing published them, and an object with
  // basis: 'inferred' when the unit count was deduced from output rather than read. Both
  // mean the same thing here: A73 did not answer.
  const measured = plants.filter((p) => p.units && p.units.basis && p.units.basis !== 'inferred');

  console.log('');
  line(measured.length > 0, `${measured.length} of ${plants.length} plants report a measured unit basis`,
    measured.length
      ? measured.map((p) => `${p.id}=${p.units.basis}`).join(' ')
      : 'every plant is null or `inferred`');
  if (measured.length === 0) {
    problems.push(
      'no plant has a measured unit basis: ENTSO-E is not answering. The token is absent, ' +
      'wrong, or set for the wrong Vercel environment - note that an env var added after a ' +
      'deployment does not reach it until the next one.',
    );
  }

  const allocMeasured = plants.filter((p) => p.generation && p.generation.confidence === 'measured');
  line(null, `${allocMeasured.length} of ${plants.length} plants have a measured generation figure`,
    allocMeasured.map((p) => p.id).join(' '));

  // --- everything the frontend loads ---------------------------------------
  console.log('');
  for (const [path, field] of [
    ['/api/v1/stations', 'stations'],
    ['/api/v1/rainfall', 'gauges'],
    ['/api/v1/alerts', 'alerts'],
    ['/api/v1/lakes', 'lakes'],
  ]) {
    try {
      const doc = await get(path);
      const n = Array.isArray(doc[field]) ? doc[field].length : null;
      line(n !== null, `${path}`, n !== null ? `${n} ${field}` : `no ${field}`);
      if (n === null) problems.push(`${path} has no ${field}`);
    } catch (err) {
      line(false, path, err.message);
      problems.push(`${path}: ${err.message}`);
    }
  }

  // The ten-year comparison, which only shows up once the archive is deployed.
  try {
    const doc = await get('/api/v1/stations');
    const withHistory = doc.stations.filter((s) => s.current && s.current.history);
    line(withHistory.length > 0, `${withHistory.length} stations carry a ten-year comparison`);
    if (!withHistory.length) problems.push('no station carries a ten-year comparison');
  } catch { /* already reported above */ }

  console.log('');
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('everything answering, on live data.');
  }
})().catch((err) => {
  console.error(`\ncould not check ${BASE}: ${err.message}`);
  process.exitCode = 1;
});
