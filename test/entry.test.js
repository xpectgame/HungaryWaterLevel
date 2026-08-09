'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { createApp } = require('../src/create-app');
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

test('every filename a framework detector scans for exports a request handler', () => {
  // Vercel's Express preset - and equivalents elsewhere - import the first conventional
  // entry filename they find and require a handler as the default export. Three
  // deployments failed because the file it picked exported factories. Whatever it lands
  // on must be serviceable, so all of them are checked here rather than the one this
  // project happens to consider canonical.
  const previous = { ...process.env };
  Object.assign(process.env, {
    DATA_PROVIDER: 'fixture',
    STORE: 'memory',
    ALLOW_FIXTURE_IN_PRODUCTION: 'true',
  });

  const candidates = ['server.js', 'src/app.js', 'api/index.js', 'src/index.js', 'app.js', 'index.js'];

  try {
    for (const candidate of candidates) {
      const full = path.join(__dirname, '..', candidate);
      if (!fs.existsSync(full)) continue;

      delete require.cache[require.resolve(full)];
      const exported = require(full);
      assert.strictEqual(typeof exported, 'function', `${candidate} must default-export a handler`);
      assert.ok(
        typeof exported.listen === 'function' || exported.length >= 2,
        `${candidate} must look like a server or a (req, res) handler`,
      );
      delete require.cache[require.resolve(full)];
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('the factories live under a name no detector scans for', () => {
  // If they moved back to app.js or server.js, a detector would import them and the
  // deployment would fail at boot again.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'create-app.js')));
  const factories = require('../src/create-app');
  assert.strictEqual(typeof factories.createApp, 'function');
  assert.strictEqual(typeof factories.createContext, 'function');
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

    // Anchored on what the page IS, not on its wording. A title assertion breaks on
    // every copy edit and tells you nothing about whether the page works.
    assert.match(html, /<svg[^>]+id="map"/, 'the map element must be present');
    assert.match(html, /\/api\/v1\/snapshot/, 'the page must poll the live endpoint');
    // Stage is live data, so the page has to refetch the station endpoint rather than
    // reading it once at load and letting the water level go stale under a live clock.
    assert.match(html, /id="levels"/, 'the stage section must be present');
    assert.match(
      html,
      /fetch\('\/api\/v1\/stations',\{cache:'no-store'\}\)/,
      'stations must be refetched uncached on every cycle, not only at load',
    );

    // Resource loads only - <script src>, <link href>, <img src>. An anchor to the data
    // source is a link a reader follows, not something the page needs to render.
    assert.doesNotMatch(
      html,
      /<(?:script|link|img|iframe)[^>]+(?:src|href)="(?:https?:)?\/\//,
      'no runtime dependency on a third-party host: the page must work when a CDN does not',
    );
  } finally {
    server.close();
    await store.close();
  }
});

test('a missing frontend asset degrades to a working page, not a 500', async () => {
  // Bundlers trace imports, not filesystem reads, so a deployment can arrive with every
  // module present and the HTML absent. The API is the product; that must not read as a
  // dead site.
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture' }),
    store: 'memory',
    lazyRefresh: false,
    backgroundPolling: false,
    publicDir: path.join(__dirname, 'no-such-directory'),
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(res.status, 200);

    const html = await res.text();

    // The fallback is deliberately not the real page: it exists so a deployment missing
    // its HTML reads as a working API rather than a dead site.
    assert.match(html, /<html/i);
    assert.match(html, /\/api\/v1\//, 'the fallback must point at the API that does work');
    // It must fetch live figures rather than show a static apology.
    assert.match(html, /\/api\/v1\/snapshot/);
  } finally {
    server.close();
    await store.close();
  }
});
