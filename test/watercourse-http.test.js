'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createApp } = require('../src/create-app');
const { createStore } = require('../src/store');
const { TtlCache } = require('../src/lib/cache');
const { loadConfig } = require('../src/config');

/**
 * The HTTP surface of /viz, over a real server.
 *
 * The domain tests next door prove the drainage logic. These prove the parts that only
 * break in the wiring: a route mounted in the wrong place, a page that renders its title
 * into the body instead of the head, an HTML injection through a stream name. None of
 * those show up in a unit test of buildWatercourse.
 */
async function withServer(fn) {
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture', DB_PATH: ':memory:' }),
    dbPath: ':memory:',
    provider: 'fixture',
    pollOnStart: false,
    cacheTtlMs: 0,
    store: 'sqlite',
    lazyRefresh: false,
    backgroundPolling: false,
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    return { status: res.status, text, type: res.headers.get('content-type') || '' };
  };
  try {
    await fn({ get });
  } finally {
    server.close();
    await store.close();
  }
}

/* --- the JSON API --------------------------------------------------------- */

test('GET /api/v1/viz/:slug answers with the drainage chain', async () => {
  await withServer(async ({ get }) => {
    const { status, text, type } = await get('/api/v1/viz/ilona-patak');
    assert.equal(status, 200);
    assert.match(type, /json/);
    const body = JSON.parse(text);
    assert.equal(body.name, 'Ilona-patak');
    assert.deepEqual(body.downstream.steps.map((s) => s.name), ['Parádi-Tarna', 'Tarna', 'Zagyva']);
  });
});

test('an unknown slug 404s WITH suggestions rather than a bare dead end', async () => {
  await withServer(async ({ get }) => {
    // Somebody types the stream the way people say it; the register spells it otherwise.
    const { status, text } = await get('/api/v1/viz/gaja');
    assert.equal(status, 404);
    const body = JSON.parse(text);
    assert.equal(body.available, false);
    assert.ok(body.suggestions.some((s) => s.name === 'Gaja-patak'),
      'the 404 must point at the name the register uses');
  });
});

test('GET /api/v1/viz?q= searches, and a one-character query is not a scan', async () => {
  await withServer(async ({ get }) => {
    const hit = JSON.parse((await get('/api/v1/viz?q=rakos')).text);
    assert.ok(hit.results.length > 0);
    assert.equal(hit.results[0].name, 'Rákos-patak');

    const tiny = JSON.parse((await get('/api/v1/viz?q=r')).text);
    assert.deepEqual(tiny.results, []);
    assert.ok(tiny.hint, 'and it says why');
  });
});

/* --- the page ------------------------------------------------------------- */

test('GET /viz/:slug is a page whose title and og:title name THIS stream', async () => {
  await withServer(async ({ get }) => {
    const { status, text, type } = await get('/viz/ilona-patak');
    assert.equal(status, 200);
    assert.match(type, /html/);

    // The entire reason this is a separate page rather than a panel on the front page.
    const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    assert.match(title, /Ilona-patak/);
    const og = (text.match(/property="og:title" content="([^"]*)"/) || [])[1] || '';
    assert.match(og, /Ilona-patak/);
    assert.match(og, /Zagyva/, 'the preview should carry where it goes');

    // Exactly one of each, or a crawler picks the wrong one.
    assert.equal((text.match(/property="og:title"/g) || []).length, 1);
    assert.equal((text.match(/property="og:description"/g) || []).length, 1);
    assert.equal((text.match(/<title>/g) || []).length, 1);
  });
});

test('the page declares a canonical URL that matches the slug', async () => {
  await withServer(async ({ get }) => {
    const { text } = await get('/viz/ilona-patak');
    const canonical = (text.match(/rel="canonical" href="([^"]*)"/) || [])[1] || '';
    assert.match(canonical, /\/viz\/ilona-patak$/);
  });
});

test('a stream that the register does not route says so, rather than showing an empty chain', async () => {
  await withServer(async ({ get }) => {
    const { text } = await get('/viz/rakos-patak');
    assert.match(text, /nem adja meg a befogadót/);
    // And it must not claim the water stops there.
    assert.match(text, /nem azt jelenti, hogy nem folyik sehova/);
  });
});

test('a trunk river gets a page instead of a 404', async () => {
  await withServer(async ({ get }) => {
    const { status, text } = await get('/viz/tisza');
    assert.equal(status, 200);
    assert.match(text, /Tisza/);
    assert.match(text, /Főfolyó/);
  });
});

test('an unknown page 404s with clickable suggestions', async () => {
  await withServer(async ({ get }) => {
    const { status, text } = await get('/viz/gaja');
    assert.equal(status, 404);
    assert.match(text, /href="\/viz\/gaja-patak"/);
  });
});

test('a name with HTML in it cannot break out of the page', async () => {
  await withServer(async ({ get }) => {
    // The query is echoed into the search page, and it is the one string on these pages
    // that comes from the reader rather than from a baked register.
    const { text } = await get('/viz?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    assert.ok(!text.includes('<script>alert(1)</script>'), 'the query was echoed raw');
    assert.match(text, /&lt;script&gt;/);
  });
});

test('the pages ask to be cached, because nothing under here changes between bakes', async () => {
  const config = {
    ...loadConfig({ DATA_PROVIDER: 'fixture', DB_PATH: ':memory:' }),
    dbPath: ':memory:', provider: 'fixture', pollOnStart: false, cacheTtlMs: 0,
    store: 'sqlite', lazyRefresh: false, backgroundPolling: false,
  };
  const store = createStore(config);
  const app = createApp({ config, store, cache: new TtlCache(0) });
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/viz/ilona-patak`);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=\d{4,}/);
  } finally {
    server.close();
    await store.close();
  }
});
