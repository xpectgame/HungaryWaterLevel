'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { boolEnv, strEnv, numEnv } = require('../src/lib/env');
const { loadConfig, assertProviderSafe } = require('../src/config');
const { bootstrap } = require('../src/lib/serverless-entry');

/**
 * These guard a failure that already happened once in production: a boolean flag that
 * did not read as true, so the app refused to boot, and because the context is built at
 * module scope the platform reported only FUNCTION_INVOCATION_FAILED.
 */

test('boolEnv accepts what people actually type into a dashboard', () => {
  for (const truthy of ['true', 'TRUE', 'True', ' true ', '"true"', "'true'", '1', 'yes', 'on']) {
    assert.strictEqual(boolEnv(truthy), true, `${JSON.stringify(truthy)} should be true`);
  }
  for (const falsy of ['false', 'FALSE', ' false ', '"false"', '0', 'no', 'off']) {
    assert.strictEqual(boolEnv(falsy), false, `${JSON.stringify(falsy)} should be false`);
  }
});

test('boolEnv falls back for unset and unrecognisable values', () => {
  assert.strictEqual(boolEnv(undefined, true), true);
  assert.strictEqual(boolEnv(null, false), false);
  assert.strictEqual(boolEnv('', true), true);
  assert.strictEqual(boolEnv('maybe', true), true);
});

test('strEnv trims whitespace and surrounding quotes', () => {
  assert.strictEqual(strEnv('  hello  '), 'hello');
  assert.strictEqual(strEnv('"quoted"'), 'quoted');
  assert.strictEqual(strEnv(''), null);
  assert.strictEqual(strEnv(undefined, 'fallback'), 'fallback');
});

test('a quoted connection string still connects', () => {
  // Pasting from a dashboard that adds quotes must not silently disable Postgres.
  const config = loadConfig({ DATABASE_URL: '"postgres://u:p@h:6543/db"' });
  assert.strictEqual(config.databaseUrl, 'postgres://u:p@h:6543/db');
  assert.strictEqual(config.store, 'postgres');
});

test('ALLOW_FIXTURE_IN_PRODUCTION works however it was typed', () => {
  for (const value of ['true', 'TRUE', ' true ', '"true"', '1']) {
    const config = loadConfig({ NODE_ENV: 'production', DATA_PROVIDER: 'fixture', ALLOW_FIXTURE_IN_PRODUCTION: value });
    assert.doesNotThrow(() => assertProviderSafe(config), `${JSON.stringify(value)} should permit boot`);
  }
});

test('the fixture guard still refuses when the flag is genuinely absent or false', () => {
  for (const value of [undefined, 'false', '0', 'no']) {
    const config = loadConfig({ NODE_ENV: 'production', DATA_PROVIDER: 'fixture', ALLOW_FIXTURE_IN_PRODUCTION: value });
    assert.throws(() => assertProviderSafe(config), /Refusing to start/);
  }
});

test('numEnv ignores junk rather than producing NaN', () => {
  assert.strictEqual(numEnv('900000', 1), 900000);
  assert.strictEqual(numEnv('  900000 ', 1), 900000);
  assert.strictEqual(numEnv('abc', 42), 42);
  assert.strictEqual(numEnv(undefined, 42), 42);
});

// ---------------------------------------------------------------------------
// Serverless bootstrap
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('bootstrap returns the built value when construction succeeds', () => {
  const { handler, error, value } = bootstrap(() => ({ ok: true }));
  assert.strictEqual(handler, null);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(value, { ok: true });
});

test('a configuration failure becomes a readable response, not an opaque crash', async () => {
  const { handler, value } = bootstrap(() => {
    throw new Error('Refusing to start: DATA_PROVIDER=fixture in production ...');
  });

  assert.strictEqual(value, null);
  assert.strictEqual(typeof handler, 'function');

  const res = fakeRes();
  await handler({ headers: {} }, res);

  assert.strictEqual(res.statusCode, 500);
  // The operator must be able to read the cause off the response itself.
  assert.match(res.body.detail, /Refusing to start/);
  assert.match(res.body.hint, /redeploy/i);
});
