'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

/**
 * Every route the app serves outside /api needs a rewrite, or it 404s in production.
 *
 * This test exists because four of them did, silently, for as long as they had existed.
 * Vercel routes /api/(.*) to the Express handler and treats everything else as a request
 * for a static file; /archive, /archive/:file, /feed.xml, /share/card.svg and
 * /embed/station/:id are all mounted at the root by src/create-app.js, so Vercel looked
 * for files that were never there and answered 404 to all of them.
 *
 * Nothing failed. The page rendered perfectly, the API worked, and the footer went on
 * telling newsrooms to subscribe to /feed.xml for flood alerts. It took a deployment
 * probe asking the live site for /archive to find it, and only because that check had
 * been added for an unrelated reason.
 *
 * The local server mounts these on Express directly and therefore cannot reproduce the
 * failure at all - which is exactly why the guard has to be against the routing file
 * rather than against a running app.
 */

/** Paths that must reach Express in production, and where they are mounted. */
const MUST_ROUTE = [
  ['/archive', 'src/routes/archive.js'],
  ['/archive/2026-08-14.json', 'src/routes/archive.js'],
  ['/feed.xml', 'src/routes/alerts.js'],
  ['/share/card.svg', 'src/routes/share.js'],
  ['/share/card.png', 'src/routes/share.js'],
  ['/embed/station/duna-budapest', 'src/routes/share.js'],
  ['/viz', 'src/routes/watercourse-page.js'],
  ['/viz/rakos-patak', 'src/routes/watercourse-page.js'],
  ['/api/v1/balance', 'src/routes/balance.js'],
  ['/api/cron', 'src/create-app.js'],
];

/**
 * Vercel's source patterns are literal paths with `(.*)` wildcards.
 *
 * Escape every regex metacharacter in the literal parts, then let the wildcards through.
 * The first version of this tried to do both in one chained set of replaces and got the
 * escaping wrong, which failed two routes that were in fact configured correctly - a
 * guard that cries wolf is worse than no guard.
 */
function matches(source, url) {
  const escaped = source
    .split('(.*)')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(url);
}

test('every non-API route the app mounts has a Vercel rewrite', () => {
  for (const [url, where] of MUST_ROUTE) {
    const hit = vercel.rewrites.some((r) => matches(r.source, url));
    assert.ok(hit, `${url} (mounted in ${where}) has no rewrite - it will 404 in production`);
  }
});

test('every rewrite points at the Express handler', () => {
  for (const r of vercel.rewrites) {
    assert.strictEqual(r.destination, '/api/index', `${r.source} points somewhere unexpected`);
  }
});

test('the rewrites are shaped the way Vercel expects', () => {
  // A stray string in this array - a comment, say - fails schema validation at deploy
  // time and takes the whole site down with it, not just the route it was describing.
  assert.ok(Array.isArray(vercel.rewrites));
  for (const r of vercel.rewrites) {
    assert.strictEqual(typeof r, 'object', 'a rewrite entry must be an object');
    assert.strictEqual(typeof r.source, 'string');
    assert.strictEqual(typeof r.destination, 'string');
  }
});

test('the map documents are cached, and the API is not cached the same way', () => {
  // waters.json is 4.7 MB and never changes between bakes; the API changes every poll.
  const rules = vercel.headers || [];
  const statics = rules.find((h) => /waters/.test(h.source));
  assert.ok(statics, 'the on-demand map documents have a cache rule');
  const cache = statics.headers.find((x) => x.key === 'Cache-Control').value;
  assert.match(cache, /max-age=\d{3,}/, 'and it is a long one');

  // Every document the map fetches by name must be in that rule. A new layer shipped
  // without being added here is served uncached - which is invisible in every test and
  // shows up only as a several-megabyte download on every page view.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fetched = new Set([...page.matchAll(/fetch\('\/([\w-]+)\.json'/g)].map((m) => m[1]));
  for (const name of fetched) {
    assert.match(statics.source, new RegExp(`\\b${name}\\b`),
      `${name}.json is fetched by the page but has no long cache rule`);
  }

  const api = rules.find((h) => h.source.startsWith('/api/v1'));
  assert.match(api.headers.find((x) => x.key === 'Cache-Control').value, /max-age=0/,
    'while the API is revalidated every time');
});

test('the poller cron still points at a path that routes', () => {
  for (const c of vercel.crons || []) {
    assert.ok(vercel.rewrites.some((r) => matches(r.source, c.path)),
      `cron ${c.path} does not reach the handler`);
  }
});
