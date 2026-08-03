'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const { TtlCache } = require('../src/lib/cache');
const { loadConfig } = require('../src/config');

/**
 * Guards a deployment failure that already happened: the host loaded the file named by
 * `main` and rejected it with "Invalid export found in module - the default export must
 * be a function or server", because that module exported named factories instead.
 *
 * Every request 500'd, including /favicon.ico, and nothing in the app's own code ran.
 */

function pkg() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
}

test('package.json main points at a file that exists', () => {
  const entry = path.join(__dirname, '..', pkg().main);
  assert.ok(fs.existsSync(entry), `${pkg().main} does not exist`);
});

test('main and the start script name the same entry point', () => {
  // Hosts disagree about which one identifies the entry. When they disagree with each
  // other, whichever the host picks decides whether the deployment boots - which is
  // exactly the coin-flip that broke this project twice.
  const { main, scripts } = pkg();
  const fromStart = scripts.start.replace(/^node\s+(--\S+\s+)*/, '').trim();

  assert.strictEqual(
    path.normalize(fromStart),
    path.normalize(main),
    `start runs ${fromStart} but main is ${main}; a host picking the other one gets a different module`,
  );
});

test('no module outside the entry is named server, so none can be mistaken for one', () => {
  const strays = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name === 'server.js') strays.push(path.relative(path.join(__dirname, '..'), full));
    }
  };
  walk(path.join(__dirname, '..'));

  assert.deepStrictEqual(strays, ['server.js'], `unexpected server.js modules: ${strays.join(', ')}`);
});

test('importing the entry point does not bind a port', async () => {
  // An imported entry that listens would fight its host for the socket, and locally it
  // would leave a stray listener behind after every test run.
  const previous = { ...process.env };
  Object.assign(process.env, { DATA_PROVIDER: 'fixture', STORE: 'memory', PORT: '3199' });

  try {
    delete require.cache[require.resolve('../server.js')];
    require('../server.js');

    // Nothing should be answering on the configured port.
    await assert.rejects(
      fetch('http://127.0.0.1:3199/api/v1/health', { signal: AbortSignal.timeout(500) }),
      'importing the entry must not start a listener',
    );
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    delete require.cache[require.resolve('../server.js')];
  }
});

test('the entry point default-exports a request handler, not an object', () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATA_PROVIDER: 'fixture',
    ALLOW_FIXTURE_IN_PRODUCTION: 'true',
    DB_PATH: ':memory:',
    STORE: 'memory',
  });

  try {
    delete require.cache[require.resolve('../server.js')];
    const entry = require('../server.js');

    assert.strictEqual(typeof entry, 'function', 'default export must be callable');
    // Express apps and http.Servers both satisfy the host; a bare object does not.
    assert.ok(
      typeof entry.listen === 'function' || entry.length >= 2,
      'export must look like a server or a (req, res) handler',
    );
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    delete require.cache[require.resolve('../server.js')];
  }
});

test('the entry point still exports a handler when configuration is broken', () => {
  const previous = { ...process.env };
  // Deliberately invalid: fixture in production without the opt-in.
  Object.assign(process.env, { NODE_ENV: 'production', DATA_PROVIDER: 'fixture' });
  delete process.env.ALLOW_FIXTURE_IN_PRODUCTION;

  try {
    delete require.cache[require.resolve('../server.js')];
    const entry = require('../server.js');
    // It must still be a function - otherwise the host rejects the module outright and
    // the readable error never reaches anyone.
    assert.strictEqual(typeof entry, 'function');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    delete require.cache[require.resolve('../server.js')];
  }
});

/**
 * The cron endpoint is mounted inside the app rather than living only as a separate
 * serverless function, so it survives the host choosing to run this as one Node server.
 */
test('the app serves /api/cron itself', async () => {
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture' }),
    store: 'sqlite',
    dbPath: ':memory:',
    cronSecret: 's3cret',
    lazyRefresh: false,
    backgroundPolling: false,
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const unauthorised = await fetch(`http://127.0.0.1:${port}/api/cron`);
    assert.strictEqual(unauthorised.status, 401, 'cron must authenticate');

    const authorised = await fetch(`http://127.0.0.1:${port}/api/cron`, {
      headers: { authorization: 'Bearer s3cret' },
    });
    assert.strictEqual(authorised.status, 200);

    const body = await authorised.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.stationsStored > 0, 'a cron run must ingest something');

    // And the ingested data is immediately visible through the API.
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.strictEqual(health.status, 200);
  } finally {
    server.close();
    await store.close();
  }
});

test('the frontend is served from the app root', async () => {
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture' }),
    store: 'memory',
    lazyRefresh: false,
    backgroundPolling: false,
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /Magyarország vízmérlege/);
  } finally {
    server.close();
    await store.close();
  }
});
