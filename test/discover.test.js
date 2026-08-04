'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractScriptUrls, extractCandidates } = require('../src/jobs/discover');

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

test('a base href pointing at a subdirectory is honoured', () => {
  const html = '<base href="/app/"><script src="main.js"></script>';
  const urls = extractScriptUrls(html, 'https://example.hu/app/index.html');
  assert.deepStrictEqual(urls, ['https://example.hu/app/main.js']);
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
