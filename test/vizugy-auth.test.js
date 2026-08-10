'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createTokenProvider, tokenExpiresAt, isTokenUsable } = require('../src/sources/vizugy-auth');

/** Build a JWT whose payload expires at a given time. Signature is irrelevant here. */
function jwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `header.${payload}.signature`;
}

test('the exp claim is read without verifying the signature', () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  assert.strictEqual(tokenExpiresAt(jwt(at)), at * 1000);
});

test('a malformed token reports no expiry rather than throwing', () => {
  assert.strictEqual(tokenExpiresAt('not-a-jwt'), null);
  assert.strictEqual(tokenExpiresAt(''), null);
});

test('a token near its expiry is replaced early', () => {
  const now = Date.now();
  // Valid for another 10 seconds - inside the refresh margin, so not usable.
  assert.strictEqual(isTokenUsable(jwt(Math.floor(now / 1000) + 10), now), false);
  assert.strictEqual(isTokenUsable(jwt(Math.floor(now / 1000) + 3600), now), true);
});

test('an unparseable token is tried rather than refused', () => {
  // The service may change format; let the server reject it, do not fail closed here.
  assert.strictEqual(isTokenUsable('opaque-token'), true);
});

test('a token is fetched once and reused until it expires', async () => {
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      return { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) };
    },
  });

  await provider.getToken();
  await provider.getToken();
  await provider.getToken();

  assert.strictEqual(calls, 1, 'a valid token must not be re-fetched');
});

test('concurrent callers share one token request', async () => {
  // A poll fires ~30 stations at once on a cold start; each must not mint its own token.
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) };
    },
  });

  const tokens = await Promise.all(Array.from({ length: 30 }, () => provider.getToken()));

  assert.strictEqual(calls, 1);
  assert.strictEqual(new Set(tokens).size, 1);
});

test('an expired token triggers exactly one refresh', async () => {
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      // First token is already past its expiry.
      const exp = calls === 1 ? Math.floor(Date.now() / 1000) - 10 : Math.floor(Date.now() / 1000) + 3600;
      return { access_token: jwt(exp) };
    },
  });

  await provider.getToken();
  await provider.getToken();
  assert.strictEqual(calls, 2);

  await provider.getToken();
  assert.strictEqual(calls, 2, 'the fresh token must now be reused');
});

test('invalidate forces the next call to fetch again', async () => {
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      return { access_token: jwt(Math.floor(Date.now() / 1000) + 3600) };
    },
  });

  await provider.getToken();
  provider.invalidate();
  await provider.getToken();

  assert.strictEqual(calls, 2);
});

test('a response without a token fails loudly', async () => {
  const provider = createTokenProvider({ fetch: async () => ({ unexpected: true }) });
  await assert.rejects(() => provider.getToken(), /No access_token/);
});

test('alternative field spellings are accepted', async () => {
  const provider = createTokenProvider({ fetch: async () => ({ accessToken: 'abc' }) });
  assert.strictEqual(await provider.getToken(), 'abc');
});

test('a failed request does not poison the provider', async () => {
  let calls = 0;
  const provider = createTokenProvider({
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error('upstream down');
      return { access_token: 'ok' };
    },
  });

  await assert.rejects(() => provider.getToken(), /upstream down/);
  // The in-flight promise must be cleared, or every later call rejects with the old error.
  assert.strictEqual(await provider.getToken(), 'ok');
});

// ---------------------------------------------------------------------------
// URL assembly
// ---------------------------------------------------------------------------

const vizugy = require('../src/sources/vizugy');

test('the service base path survives URL assembly', () => {
  // new URL('/TS/TsShort', 'https://h/vraquery') resolves to 'https://h/TS/TsShort' -
  // the base path is dropped. Here that would silently address the wrong service.
  assert.strictEqual(
    vizugy.seriesUrl(vizugy.config({})),
    'https://vmservice.vizugy.hu/vraquery/TS/TsShort',
  );
});

test('a base with a trailing slash does not double it', () => {
  const cfg = { ...vizugy.config({}), baseUrl: 'https://h/vraquery/', seriesPath: 'TS/TsShort' };
  assert.strictEqual(vizugy.seriesUrl(cfg), 'https://h/vraquery/TS/TsShort');
});

test('every mapped id names a station that exists, and none is a placeholder', () => {
  // A törzsszám that does not resolve is the failure mode this whole mapping is careful
  // about: it does not error, it reports a different river under the right name.
  const { getStation } = require('../src/config/stations');
  for (const [id, tsz] of Object.entries(vizugy.EXTERNAL_IDS)) {
    assert.ok(getStation(id), `EXTERNAL_IDS names an unknown station: ${id}`);
    assert.match(String(tsz), /^\d+$/, `törzsszám for ${id} is not numeric: ${tsz}`);
  }
});

test('two stations never share a törzsszám', () => {
  const seen = new Map();
  for (const [id, tsz] of Object.entries(vizugy.EXTERNAL_IDS)) {
    assert.ok(!seen.has(tsz), `${id} and ${seen.get(tsz)} both map to ${tsz}`);
    seen.set(tsz, id);
  }
});

test('the request asks for discharge in m3/s from the real-time feed', () => {
  // 68 is stage in centimetres and 5 is the forecast. Either substitution returns a
  // number that passes every plausibility check this project has.
  const cfg = vizugy.config({});
  const [entry] = vizugy.buildRequest([{ id: 'duna-rajka' }], cfg, new Date('2026-08-08T12:00:00Z'));

  assert.strictEqual(entry.AdatFajtaKod, 87, 'Felszíni vízhozam, m3/s');
  assert.strictEqual(entry.AdatTipusKod, 100, 'operatív');
  assert.strictEqual(entry.Torzsszam, 1);
  assert.strictEqual(entry.ItemId, 0);
  assert.strictEqual(entry.StartTime, '2026-08-07T12:00:00.000Z');
});

test('every station goes into one request, indexed so the response maps back', () => {
  const cfg = vizugy.config({});
  const stations = vizugy.mappedStations();
  const body = vizugy.buildRequest(stations, cfg);

  // Two series per station - discharge and stage - in the same POST. Each entry carries
  // its own AdatFajtaKod, so asking for both costs no extra request.
  assert.strictEqual(body.length, stations.length * 2);
  assert.deepStrictEqual(
    body.map((entry) => entry.ItemId),
    body.map((_, index) => index),
    'ItemId must stay dense and unique, or one series answers for another',
  );

  const discharge = body.slice(0, stations.length);
  const stage = body.slice(stations.length);
  assert.ok(discharge.every((e) => e.AdatFajtaKod === 87), 'the first block is discharge');
  assert.ok(stage.every((e) => e.AdatFajtaKod === 68), 'the second block is stage');
  assert.deepStrictEqual(
    discharge.map((e) => e.Torzsszam),
    stage.map((e) => e.Torzsszam),
    'the two blocks must run in the same station order',
  );
});

test('stage is carried alongside discharge, and its absence does not lose the flow', () => {
  // A gauge can publish discharge and not stage. Dropping the reading over the missing
  // extra would be the wrong trade - the balance needs the discharge.
  const entry = (id, adat) => ({ ItemId: id, TsItemList: [{ UTCTime: '2026-08-08T12:00:00Z', Adat: adat }] });
  assert.strictEqual(vizugy.latestSample(entry(0, 812.4)).flowM3s, 812.4);
  assert.strictEqual(vizugy.latestSample(undefined), null);
});

test('the newest sample wins regardless of the order they arrive in', () => {
  const sample = vizugy.latestSample({
    ItemId: 0,
    TsItemList: [
      { UTCTime: '2026-08-08T10:00:00Z', Adat: 400 },
      { UTCTime: '2026-08-08T12:00:00Z', Adat: 411.219 },
      { UTCTime: '2026-08-08T11:00:00Z', Adat: 405 },
    ],
  });

  assert.strictEqual(sample.flowM3s, 411.219);
  assert.strictEqual(sample.timestamp, '2026-08-08T12:00:00.000Z');
});

test('a gap in the series is skipped rather than read as zero', () => {
  // The feed carries an hourly slot whether or not the gauge reported, and Number(null)
  // is 0 - a discharge of zero is a physically meaningful and completely wrong value.
  const sample = vizugy.latestSample({
    TsItemList: [
      { UTCTime: '2026-08-08T10:00:00Z', Adat: 411 },
      { UTCTime: '2026-08-08T12:00:00Z', Adat: null },
    ],
  });

  assert.strictEqual(sample.flowM3s, 411);
});

test('a series with nothing usable reports nothing, not a fabricated sample', () => {
  assert.strictEqual(vizugy.latestSample({ TsItemList: [] }), null);
  assert.strictEqual(vizugy.latestSample(undefined), null);
  assert.strictEqual(vizugy.latestSample({ TsItemList: [{ UTCTime: 'nonsense', Adat: 5 }] }), null);
});

test('a response entry that omits ItemId is the one numbered zero', () => {
  // Observed against the live service: it leaves `ItemId` out of the JSON entirely when
  // its value is 0, so `Number(entry.ItemId)` was NaN for exactly one entry in every
  // response. `duna-rajka` is index 0, and it had been silently reporting "no sample in
  // the requested window" on every poll while the other twenty-eight gauges worked.
  const entries = [
    { TsItemList: [{ UTCTime: '2026-08-08T12:00:00Z', Adat: 411 }] }, // no ItemId at all
    { ItemId: 1, TsItemList: [] },
    { ItemId: 2, TsItemList: [] },
  ];

  const byItemId = vizugy.indexByItemId(entries);
  assert.strictEqual(byItemId.get(0), entries[0], 'a missing ItemId must resolve to 0');
  assert.strictEqual(byItemId.get(1), entries[1]);
  assert.strictEqual(vizugy.latestSample(byItemId.get(0)).flowM3s, 411);
});

test('an explicit zero is not displaced by an entry that merely omits the field', () => {
  // Defensive: if the service ever omits ItemId for some reason other than the zero
  // default, the entry that actually claims 0 must keep it rather than being overwritten.
  const explicit = { ItemId: 0, TsItemList: [{ UTCTime: '2026-08-08T12:00:00Z', Adat: 100 }] };
  const bare = { TsItemList: [{ UTCTime: '2026-08-08T12:00:00Z', Adat: 999 }] };

  assert.strictEqual(vizugy.indexByItemId([explicit, bare]).get(0), explicit);
  assert.strictEqual(vizugy.indexByItemId([bare, explicit]).get(0), explicit);
});

test('every station in the request can be found in a response shaped like the real one', () => {
  // End to end over the indexing rule: build the real request, answer it the way the
  // service does - omitting ItemId 0 - and check that no station is left unmatched.
  const stations = vizugy.mappedStations();
  const body = vizugy.buildRequest(stations, vizugy.config(), new Date());

  const response = body.map((entry) => {
    const row = { TsItemList: [{ UTCTime: '2026-08-08T12:00:00Z', Adat: 1 }] };
    if (entry.ItemId !== 0) row.ItemId = entry.ItemId;
    return row;
  });

  const byItemId = vizugy.indexByItemId(response);
  const missing = body.filter((entry) => !byItemId.has(entry.ItemId)).map((entry) => entry.ItemId);
  assert.deepStrictEqual(missing, [], 'every requested series must be locatable in the response');
});

// ---------------------------------------------------------------------------
// Request headers
// ---------------------------------------------------------------------------

const { browserHeaders } = require('../src/lib/http');

test('the token request carries the headers the portal sends', () => {
  // The endpoint answered 403, not 404: it exists and was refusing this request
  // specifically. A single-page app always sends Origin and Referer, and a gateway
  // that checks them rejects anything that does not.
  const headers = browserHeaders('https://data.vizugy.hu');

  assert.strictEqual(headers.Origin, 'https://data.vizugy.hu');
  assert.strictEqual(headers.Referer, 'https://data.vizugy.hu/');
  assert.match(headers.Accept, /application\/json/);
});

test('the origin is derived from the configured auth URL, not hard-coded', async () => {
  // A self-hosted or staging deployment must send its own origin, or it gets the 403
  // this exists to avoid.
  let seenUrl = null;
  const provider = createTokenProvider({
    authBaseUrl: 'https://staging.example.hu/AuthApi/auth',
    fetch: async (url) => {
      seenUrl = url;
      return { access_token: 'x' };
    },
  });

  await provider.getToken();
  assert.strictEqual(seenUrl, 'https://staging.example.hu/AuthApi/auth/token');
});

test('seriesUrl names the config it was handed instead of throwing on a missing field', () => {
  // The probe passed MAVIR's config to this function by accident and got "cannot read
  // properties of undefined (reading 'startsWith')", which named neither side.
  const mavirConfig = require('../src/sources/mavir').config({});

  assert.throws(
    () => vizugy.seriesUrl(mavirConfig),
    (err) => /vizugy config/.test(err.message) && /baseUrl/.test(err.message),
  );
});
