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

  // `lastPoll.detail.errors`, not `lastPoll.errors`. The first version of this check read
  // the shallower path, got undefined, and printed "0 upstream error(s)" as an `ok` -
  // against a deployment that was in fact failing to store generation. A check that
  // reports a field it cannot find as good news is worse than no check, because it is
  // the one you believe. Both the flag and the count are read now.
  const poll = health.lastPoll || {};
  const detail = poll.detail || {};
  const errors = detail.errors || [];

  // Two station gaps are permanent, documented properties of the upstream network rather
  // than faults, and they make every poll report failure:
  //
  //   lajta-mosonmagyarovar   no usable gauge exists on the Lajta, so no törzsszám
  //   tisza-tiszasziget       publishes stage but frequently no discharge
  //
  // A check that goes red every single run is a check nobody reads by the second week,
  // and it would have buried the real finding above it. They are counted and shown, but
  // they do not fail the run - anything else does.
  const KNOWN_GAPS = new Set(['lajta-mosonmagyarovar', 'tisza-tiszasziget']);
  const stationErrors = errors.flatMap((e) => e.stationErrors || []);
  const unexpected = stationErrors.filter((e) => !KNOWN_GAPS.has(e.stationId));
  const otherErrors = errors.filter((e) => !e.stationErrors);

  line(true, `${stationErrors.length} station gap(s) on the last poll`,
    `${stationErrors.length - unexpected.length} known, ${unexpected.length} unexpected`);

  if (unexpected.length) {
    line(false, 'unexpected station errors', JSON.stringify(unexpected).slice(0, 400));
    problems.push(`${unexpected.length} unexpected station error(s): ${JSON.stringify(unexpected).slice(0, 200)}`);
  }
  if (otherErrors.length) {
    line(false, `${otherErrors.length} non-station upstream error(s)`, JSON.stringify(otherErrors).slice(0, 400));
    problems.push(`${otherErrors.length} upstream error(s): ${JSON.stringify(otherErrors).slice(0, 200)}`);
  }
  // `lastPoll.ok` is false whenever ANY station is missing, so it is false permanently
  // and says nothing on its own. Reported, never failed on - the lines above decide.
  line(true, `last poll ok=${poll.ok}`, poll.timestamp || 'never ran');

  // Whether the poll actually WROTE what it fetched. A poll can succeed, store the
  // stations, and quietly store no generation - which is exactly the shape of a MAVIR
  // rate-limit, and invisible in every other field.
  line(detail.generationStored !== false, `generation stored = ${detail.generationStored}`,
    `${detail.stationsStored ?? '?'} station readings, ${detail.stationsRejected ?? '?'} rejected`);
  if (detail.generationStored === false) {
    problems.push('the last poll stored no generation - MAVIR did not answer usably (it rate-limits hard: a burst puts the whole host into 429)');
  }

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

  // Generation, which is a SEPARATE upstream from the one above: unit counts come from
  // ENTSO-E, the megawatts from MAVIR's source-type aggregates. This started as an
  // informational line and became a check the first time it ran against production,
  // where it read 0 of 8 while ENTSO-E was working perfectly - two upstreams, one of
  // them down, and the line that would have said so was not allowed to fail.
  const withPower = plants.filter((p) => p.generation && Number.isFinite(p.generation.powerMw));
  const allocMeasured = plants.filter((p) => p.generation && p.generation.confidence === 'measured');
  line(withPower.length > 0, `${withPower.length} of ${plants.length} plants have a generation figure at all`,
    allocMeasured.length ? `${allocMeasured.length} measured: ${allocMeasured.map((p) => p.id).join(' ')}` : 'none measured');
  if (withPower.length === 0) {
    problems.push(
      'no plant has any generation figure: the MAVIR source-type aggregate is not landing. ' +
      'Every cooling-water number on the site depends on it, and this is independent of ENTSO-E.',
    );
  }

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
