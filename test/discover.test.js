'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractScriptUrls, extractInlineScripts, extractCandidates } = require('../src/jobs/discover');

/**
 * The portals are single-page applications, so their HTML carries no endpoint to read
 * and no data to parse. Guessing paths produced 404s. What the bundles do carry is the
 * URL they fetch from, as an ordinary string literal - these two functions get it out.
 */

const ANGULAR_SHELL = `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><title>Opendata</title>
  <base href="/">
  <link rel="icon" type="image/svg+xml" href="assets/logo.svg">
  <link rel="modulepreload" href="/chunk-XYZ.js">
</head><body><app-root></app-root>
  <script src="polyfills-ABC.js" type="module"></script>
  <script src="/main-DEF.js" type="module"></script>
</body></html>`;

test('script URLs are resolved against the document base', () => {
  const urls = extractScriptUrls(ANGULAR_SHELL, 'https://data.vizugy.hu/');

  assert.ok(urls.includes('https://data.vizugy.hu/polyfills-ABC.js'), 'relative src');
  assert.ok(urls.includes('https://data.vizugy.hu/main-DEF.js'), 'root-relative src');
  assert.ok(urls.includes('https://data.vizugy.hu/chunk-XYZ.js'), 'modulepreload chunk');
});

test('without a base tag, scripts resolve against the page, not the origin', () => {
  // Defaulting to the origin moved every relative script to the site root. A Swagger UI
  // served from /vraquery/swagger/ reported its bundles as /swagger-ui-bundle.js, all of
  // which 404'd - and the one that names the OpenAPI document was among them.
  const html = '<script src="./swagger-ui-bundle.js"></script><script src="./index.js"></script>';
  const urls = extractScriptUrls(html, 'https://vmservice.vizugy.hu/vraquery/swagger/index.html');

  assert.deepStrictEqual(urls, [
    'https://vmservice.vizugy.hu/vraquery/swagger/swagger-ui-bundle.js',
    'https://vmservice.vizugy.hu/vraquery/swagger/index.js',
  ]);
});

test('a base href pointing at a subdirectory is honoured', () => {
  const html = '<base href="/app/"><script src="main.js"></script>';
  const urls = extractScriptUrls(html, 'https://example.hu/app/index.html');
  assert.deepStrictEqual(urls, ['https://example.hu/app/main.js']);
});

// ---------------------------------------------------------------------------
// Inline scripts
// ---------------------------------------------------------------------------

/** What a generated API explorer actually serves - the config is in the page. */
const SWAGGER_SHELL = `<!DOCTYPE html><html><head><title>Swagger UI</title>
  <link rel="stylesheet" href="./swagger-ui.css">
</head><body>
  <div id="swagger-ui"></div>
  <script src="./swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({ url: "/vraquery/swagger/v1/swagger.json", dom_id: "#swagger-ui" });
    };
  </script>
</body></html>`;

test('inline script blocks are read, and referenced ones are not duplicated', () => {
  // Mining only <script src=...> missed the config entirely: the referenced bundle is
  // stock Swagger UI, so every literal in it is about the spec format, not this API.
  const blocks = extractInlineScripts(SWAGGER_SHELL);

  assert.strictEqual(blocks.length, 1);
  assert.match(blocks[0], /SwaggerUIBundle/);
  assert.doesNotMatch(blocks[0], /swagger-ui-bundle\.js/, 'the referenced script is not inline content');
});

test('the OpenAPI document URL is recovered from the inline config', () => {
  const [block] = extractInlineScripts(SWAGGER_SHELL);
  const found = [...extractCandidates(block, 'https://vmservice.vizugy.hu/vraquery/swagger/index.html').keys()];

  assert.ok(
    found.includes('https://vmservice.vizugy.hu/vraquery/swagger/v1/swagger.json'),
    `spec URL missing from ${JSON.stringify(found)}`,
  );
});

test('a relative spec URL is found and resolved against the page', () => {
  // What the service actually serves: no inline script at all, a stock swagger-ui-dist
  // shell plus a small initialiser beside it. NSwag writes the document location
  // relative to that page, and requiring a leading slash meant the one literal worth
  // finding in the whole file was the one shape not being looked for.
  const initialiser = 'var configuration = { url: "v1/swagger.json", validatorUrl: null };';
  const found = [...extractCandidates(initialiser, 'https://vmservice.vizugy.hu/vraquery/swagger/index.html').keys()];

  assert.ok(
    found.includes('https://vmservice.vizugy.hu/vraquery/swagger/v1/swagger.json'),
    `spec URL missing from ${JSON.stringify(found)}`,
  );
});

test('a ./ or ../ prefixed path is resolved too', () => {
  const found = [...extractCandidates('u("../api/v1/measurements")', 'https://x.hu/app/page.html').keys()];
  assert.ok(found.includes('https://x.hu/api/v1/measurements'), JSON.stringify(found));
});

test('bare identifiers are not mistaken for relative paths', () => {
  // Without requiring a slash, every minified identifier in a bundle qualifies and the
  // output becomes unreadable.
  const found = [...extractCandidates('"apiClient";"dataService";"stationList"', 'https://x.hu/').keys()];
  assert.deepStrictEqual(found, []);
});

test('empty and whitespace-only script blocks are dropped', () => {
  assert.deepStrictEqual(extractInlineScripts('<script></script><script>  \n </script>'), []);
});

test('a script with attributes but no src still counts as inline', () => {
  const blocks = extractInlineScripts('<script type="text/javascript" defer>var u="/api/x";</script>');
  assert.deepStrictEqual(blocks, ['var u="/api/x";']);
});

test('endpoint-looking string literals are pulled out of a bundle', () => {
  const bundle = `
    const e = { apiUrl: "/api/v1/stations", other: "https://data.vizugy.hu/rest/measurements" };
    fetch("/api/station/" + id + "/discharge");
    t("./assets/logo.svg"); u("/styles.css"); v("/main.js.map");
  `;
  const found = [...extractCandidates(bundle, 'https://data.vizugy.hu/').keys()];

  assert.ok(found.includes('https://data.vizugy.hu/api/v1/stations'));
  assert.ok(found.includes('https://data.vizugy.hu/rest/measurements'));
  assert.ok(found.includes('https://data.vizugy.hu/api/station/'));
});

test('assets are not mistaken for endpoints', () => {
  const bundle = '"/assets/api-icon.svg";"/data/chart.css";"/api/v1/main.js";"/api/real"';
  const found = [...extractCandidates(bundle, 'https://example.hu/').keys()];

  for (const url of found) {
    assert.doesNotMatch(url, /\.(svg|css|js|map|png|woff2?)$/, `${url} is an asset, not an endpoint`);
  }
  assert.ok(found.includes('https://example.hu/api/real'));
});

test('strings without an endpoint hint are ignored', () => {
  // A bundle is mostly not endpoints; without filtering the output is unreadable.
  const bundle = '"/foo/bar";"/x/y/z";"/api/measurements"';
  const found = [...extractCandidates(bundle, 'https://example.hu/').keys()];

  assert.deepStrictEqual(found, ['https://example.hu/api/measurements']);
});

test('repeated candidates are counted, so the busiest endpoint ranks first', () => {
  const bundle = '"/api/rare";"/api/common";"/api/common";"/api/common"';
  const found = extractCandidates(bundle, 'https://example.hu/');

  assert.strictEqual(found.get('https://example.hu/api/common'), 3);
  assert.strictEqual(found.get('https://example.hu/api/rare'), 1);
});

test('data: and blob: URLs are skipped', () => {
  const bundle = '"data:application/json;base64,eyJhIjoxfQ==";"/api/ok"';
  const found = [...extractCandidates(bundle, 'https://example.hu/').keys()];
  assert.deepStrictEqual(found, ['https://example.hu/api/ok']);
});

test('templated paths survive extraction', () => {
  // They cannot be called as-is, but they name the parameter the real request needs -
  // which is exactly what has to be filled into the adapter configuration.
  const bundle = '"/api/stations/${id}/data";"/api/v1/{stationId}/discharge"';
  const found = [...extractCandidates(bundle, 'https://example.hu/').keys()];

  assert.ok(found.some((u) => u.includes('${id}') || u.includes('%7BstationId%7D') || u.includes('{stationId}')));
});

// ---------------------------------------------------------------------------
// Frames and documentation
// ---------------------------------------------------------------------------

const { extractFrameUrls, decodeHtml } = require('../src/jobs/discover');
const { htmlToText } = require('../src/jobs/docs');

test('embedded frames are found and their URLs unescaped', () => {
  // Portal software composes pages out of portlets, and a chart is often an iframe
  // pointing at a separate app - which is where the data endpoint actually lives.
  const html = '<iframe src="/rtdwweb/webuser/chart?id=7678&amp;lang=hu"></iframe>';
  const frames = extractFrameUrls(html, 'https://www.mavir.hu/web/mavir/rendszerterheles');

  assert.deepStrictEqual(frames, ['https://www.mavir.hu/rtdwweb/webuser/chart?id=7678&lang=hu']);
});

test('HTML entities in a src do not corrupt the query string', () => {
  // An &amp; left in place turns two parameters into one named "amp;lang".
  assert.strictEqual(decodeHtml('a=1&amp;b=2'), 'a=1&b=2');
  assert.strictEqual(decodeHtml('&quot;x&quot;'), '"x"');
});

test('script sources are unescaped too', () => {
  const html = '<script src="/main.js?a=1&amp;b=2"></script>';
  const [url] = extractScriptUrls(html, 'https://example.hu/');
  assert.strictEqual(url, 'https://example.hu/main.js?a=1&b=2');
});

test('documentation is flattened to readable text, keeping link targets', () => {
  // On an API help page the URL in a link often is the answer.
  const html = '<html><head><style>a{}</style></head><body><h1>Query</h1>' +
    '<p>See <a href="/vraquery/list">the list call</a>.</p><script>x()</script></body></html>';
  const text = htmlToText(html);

  assert.match(text, /Query/);
  assert.match(text, /\[\/vraquery\/list\]/, 'link target must survive');
  assert.doesNotMatch(text, /x\(\)/, 'script contents must be stripped');
  assert.doesNotMatch(text, /a\{\}/, 'style contents must be stripped');
});

// ---------------------------------------------------------------------------
// Diagnosing what actually failed
// ---------------------------------------------------------------------------

const { describeCause } = require('../src/lib/http');
const { dumpContext } = require('../src/jobs/discover');

test('a transport failure names its real cause, not "fetch failed"', () => {
  // fetch reports every transport problem with the same three words and hides the
  // reason in `cause`. A TLS rejection and a DNS miss need different responses.
  const tls = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  const outer = Object.assign(new TypeError('fetch failed'), { cause: tls });

  const described = describeCause(outer);
  assert.match(described, /fetch failed/);
  assert.match(described, /unable to verify the first certificate/);
  assert.match(described, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
});

test('cause unwrapping terminates on a cycle', () => {
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b;
  b.cause = a;
  assert.match(describeCause(a), /a.*b/s);
});

test('source context shows how a base URL is completed at runtime', () => {
  // The reason a discovered base 404s: the rest of the path is concatenated in code,
  // so it never appears as a literal. The window around it is where the answer is.
  const sources = new Map([
    ['https://x/main.js', 'const b="https://vmservice.vizugy.hu/vraquery/";f(b+t+"/list?stationId="+id)'],
  ]);

  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const hits = dumpContext(sources, 'vraquery');
    assert.strictEqual(hits, 1);
  } finally {
    console.log = original;
  }

  assert.ok(logged.join('\n').includes('stationId'), 'the surrounding call must be shown');
});

test('a missing needle is reported rather than silently printing nothing', () => {
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    assert.strictEqual(dumpContext(new Map([['u', 'nothing here']]), 'vraquery'), 0);
  } finally {
    console.log = original;
  }
  assert.match(logged.join('\n'), /not found as a literal/);
});

test('framework boilerplate is mined but not printed', () => {
  // MAVIR's portal ships fourteen inline blocks totalling 23 KB - Liferay bootstrapping,
  // AUI form wiring, Google Analytics - and not one names a data endpoint. Printed in
  // full they bury the single line worth reading.
  const { extractInlineScripts: extract } = require('../src/jobs/discover');
  const html = `
    <script>var Liferay = Liferay || {}; Liferay.ThemeDisplay = {};</script>
    <script>var chart = { dataUrl: "/rtdwweb/webuser/DataServlet?tabId=tab4402" };</script>`;

  const blocks = extract(html);
  assert.strictEqual(blocks.length, 2, 'both blocks are still read');

  // The endpoint must survive the noise filter, since mining is what it is for.
  const found = [...extractCandidates(blocks.join('\n'), 'https://rtdwweb.mavir.hu/').keys()];
  assert.ok(
    found.some((u) => u.includes('DataServlet')),
    `endpoint lost from ${JSON.stringify(found)}`,
  );
});
