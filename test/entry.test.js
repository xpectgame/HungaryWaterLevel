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
    assert.match(html, /id="lakes"/, 'the lakes section must be present');
    assert.match(html, /\/api\/v1\/lakes/, 'the page must poll the lake endpoint');

    // Every nav link must point at a section that exists, or the bar silently loses an
    // entry and the scroll-spy skips a step.
    const navLinks = [...html.matchAll(/<a href="#(s-[a-z]+)">/g)].map((m) => m[1]);
    assert.ok(navLinks.length >= 6, `expected a nav bar, found ${navLinks.length} links`);
    for (const id of navLinks) {
      assert.ok(html.includes(`id="${id}"`), `nav points at #${id}, which no section carries`);
    }

    // The hypothetical view must never be able to appear without the warning that it is
    // one: the banner and the striped background are the only things separating it from
    // a screenshot of today's readings.
    assert.match(html, /id="feed"/, 'the events feed must be present');
    assert.match(html, /\/api\/v1\/events/, 'the page must poll the events endpoint');

    // Rainfall is the input side of the whole system, and the two caveats about it are
    // not optional decoration: an empty Transdanubia has to read as unmeasured rather
    // than dry, and the baseline has to admit it is a recent decade.
    assert.match(html, /id="s-csapadek"/, 'the rainfall section must be present');
    assert.match(html, /\/api\/v1\/rainfall/, 'the page must poll the rainfall endpoint');
    assert.match(html, /id="rain-coverage"/, 'coverage limits must have somewhere to appear');
    assert.match(html, /id="rain-baseline"/, 'the baseline caveat must have somewhere to appear');
    assert.match(html, /id="layer-rain"/, 'the map needs a rain layer');

    // The travel-time projection must never be able to render without the sentence
    // saying it is not a forecast.
    assert.match(html, /id="arrivals"/, 'the arrival list must be present');
    assert.match(html, /id="arrivals-note"/, 'the arrival disclaimer must have somewhere to appear');

    // The rainfall window buttons wear .sortbar for its styling, so anything that binds
    // behaviour by that class picks them up too - which it did once, setting the bar
    // sort to undefined and throwing on every redraw.
    assert.doesNotMatch(
      html,
      /querySelectorAll\('\.sortbar button'\)/,
      'bind the sort control by data-sort, not by the class the rain switcher shares',
    );
    // Derived measurements and a person's sourced claim must not share a style.
    assert.match(html, /\.ev\.note/, 'editorial notes need their own visual treatment');
    assert.match(html, /szerkesztői jegyzet/, 'editorial notes must be labelled as written by a person');

    assert.match(html, /id="mode-normal"/, 'the scenario switch must be present');
    assert.match(html, /id="whatif"/, 'the hypothetical must carry its warning banner');
    assert.match(html, /body\.what-if/, 'the hypothetical must be visually marked');
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

/**
 * The map, by keyboard.
 *
 * Every failure guarded here is SILENT - the page renders, nothing throws, and the only
 * way to notice is to put the mouse down and try to use it. Three of the five were real
 * states this file passed through.
 */
test('the map is navigable without a mouse', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const map = page.match(/<svg[^>]+id="map"[^>]*>/)[0];

  // role="img" makes assistive technology treat the map as one opaque picture and hide
  // its children, so focusable markers inside it would be announced as nothing at all.
  assert.doesNotMatch(map, /role="img"/, 'role="img" hides the markers from screen readers');
  assert.match(map, /role="group"/, 'the map is a group of markers, not a picture');
  assert.match(map, /tabindex="0"/, 'the map must be a tab stop, or nothing inside it is reachable');
  // A stop that swallows the arrow keys without saying so is worse than one that is not
  // focusable: the reader presses Tab, hears a label, and has no idea what to do next.
  assert.match(map, /aria-label="[^"]*[Nn]yíl/, 'the label must say the arrow keys work here');

  // Dead code, not a broken feature: every handler below is defined on an element that
  // never gets one, no error is raised, and the map is simply mouse-only again. This
  // file sat in exactly that state.
  assert.match(page, /^\s*initMapKeys\(\);/m, 'initMapKeys is defined but must also be called');

  // getBBox reports the box BEFORE the element's own transform, and the gauge and plant
  // markers are groups translated into place - so it returns the same number for all of
  // them and the sort degrades to document order, which walks the map once per layer.
  assert.doesNotMatch(
    page,
    /getBBox\(\)\.x/,
    'order markers by getBoundingClientRect: getBBox ignores the marker\'s own transform',
  );
  assert.match(page, /getBoundingClientRect\(\)\.left/, 'markers are ordered west to east on screen');

  // Markers are tabindex="-1" on purpose. At tabindex="0" there are eighty-seven of
  // them between the map and the rest of the page, all repeating what the lists below
  // already say.
  assert.match(page, /setAttribute\('tabindex', '-1'\)/, 'markers must not each be a tab stop');
  assert.match(page, /setAttribute\('aria-label'/, 'a marker must announce its reading, not its shape');

  // The keyboard trap. Markers are tabindex="-1", so Shift+Tab out of the westernmost
  // one goes to the previous TABBABLE element - which is the map, because it encloses
  // them. Forwarding focus into a marker when the map receives focus closes the loop
  // and there is no way out of the map by keyboard.
  assert.doesNotMatch(
    page,
    /map\.addEventListener\('focus'/,
    'do not forward focus into a marker: Shift+Tab lands back on the map and would loop',
  );
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
