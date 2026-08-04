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
  // new URL('/x', 'https://h/vraquery') resolves to 'https://h/x' - the base path is
  // dropped. Here that would silently address the wrong service.
  const cfg = { ...vizugy.config({}), path: '/{externalId}/discharge/latest' };
  const url = vizugy.buildUrl(cfg, { id: 'duna-rajka' });

  assert.ok(url.startsWith('https://vmservice.vizugy.hu/vraquery/'), `got ${url}`);
  assert.ok(url.endsWith('/duna-rajka/discharge/latest'));
});

test('a base with a trailing slash does not double it', () => {
  const cfg = { ...vizugy.config({}), baseUrl: 'https://h/vraquery/', path: 'stations' };
  assert.strictEqual(vizugy.buildUrl(cfg, { id: 'x' }), 'https://h/vraquery/stations');
});

test('station ids are URL-encoded into the path', () => {
  const cfg = { ...vizugy.config({}), path: '/{stationId}/data' };
  assert.match(vizugy.buildUrl(cfg, { id: 'a b/c' }), /a%20b%2Fc/);
});
