'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createCronHandler } = require('../src/jobs/cron-handler');
const { MemoryStore } = require('../src/store/memory');
const { TimeseriesStore } = require('../src/store/timeseries');
const { TtlCache } = require('../src/lib/cache');
const { loadConfig } = require('../src/config');

/** Minimal req/res doubles - enough to assert status and body. */
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

function ctxWith(overrides = {}, store) {
  return {
    config: { ...loadConfig({ DATA_PROVIDER: 'fixture' }), store: 'sqlite', ...overrides },
    store: store || new TimeseriesStore(':memory:'),
    cache: new TtlCache(0),
  };
}

test('cron rejects a request without the secret', async () => {
  const handler = createCronHandler(ctxWith({ cronSecret: 's3cret' }));
  const res = fakeRes();

  await handler({ headers: {} }, res);

  assert.strictEqual(res.statusCode, 401);
  // The error must not hint at what the secret looks like.
  assert.strictEqual(res.body.error, 'Unauthorized');
});

test('cron rejects a wrong secret', async () => {
  const handler = createCronHandler(ctxWith({ cronSecret: 's3cret' }));
  const res = fakeRes();

  await handler({ headers: { authorization: 'Bearer nope' } }, res);
  assert.strictEqual(res.statusCode, 401);
});

test('cron accepts the correct bearer token and ingests', async () => {
  const store = new TimeseriesStore(':memory:');
  const handler = createCronHandler(ctxWith({ cronSecret: 's3cret' }, store));
  const res = fakeRes();

  await handler({ headers: { authorization: 'Bearer s3cret' } }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.stationsStored > 0);
  assert.ok((await store.stats()).stationReadings > 0);
});

test('cron refuses to run unauthenticated in production', async () => {
  const handler = createCronHandler(ctxWith({ cronSecret: null, nodeEnv: 'production' }));
  const res = fakeRes();

  await handler({ headers: {} }, res);

  assert.strictEqual(res.statusCode, 500);
  assert.match(res.body.error, /CRON_SECRET is not set/);
});

test('cron refuses a memory store, which would write where nobody reads', async () => {
  const handler = createCronHandler(ctxWith({ cronSecret: 's3cret', store: 'memory' }, new MemoryStore()));
  const res = fakeRes();

  await handler({ headers: { authorization: 'Bearer s3cret' } }, res);

  assert.strictEqual(res.statusCode, 500);
  assert.match(res.body.error, /shared storage/);
});

test('cron reports a failed cycle as 500 rather than a silent success', async () => {
  const handler = createCronHandler(ctxWith({ cronSecret: 's3cret' }), {
    poll: async () => {
      throw new Error('upstream exploded');
    },
  });
  const res = fakeRes();

  await handler({ headers: { authorization: 'Bearer s3cret' } }, res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /upstream exploded/);
});

test('cron prunes only occasionally', async () => {
  let pruneCalls = 0;
  const store = new TimeseriesStore(':memory:');
  store.prune = async () => {
    pruneCalls += 1;
    return 0;
  };

  const never = createCronHandler(ctxWith({ cronSecret: 's' }, store), { random: () => 0.5 });
  await never({ headers: { authorization: 'Bearer s' } }, fakeRes());
  assert.strictEqual(pruneCalls, 0);

  const always = createCronHandler(ctxWith({ cronSecret: 's' }, store), { random: () => 0.001 });
  await always({ headers: { authorization: 'Bearer s' } }, fakeRes());
  assert.strictEqual(pruneCalls, 1);
});
