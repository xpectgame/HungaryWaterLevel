'use strict';

const { fetchText, browserHeaders } = require('../lib/http');

/**
 * Finds the API a single-page application talks to.
 *
 * data.vizugy.hu serves an Angular shell - `<app-root>`, a `<base href>`, and a handful
 * of hashed bundles. There is no endpoint to guess from the HTML, because the HTML
 * contains no data. But the bundle that renders the charts must contain the URL it
 * fetches them from, as a plain string.
 *
 * So: download the page, download every script it references, pull out the string
 * literals that look like endpoints, then actually call the promising ones and report
 * which returned JSON. That turns "guess the path and get a 404" into an answer.
 */

// Bundles are the interesting artefact and can be large; anything past this is almost
// certainly a vendor chunk, and downloading it wastes the runner's time.
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_PROBES = 30;

// Inline blocks are printed verbatim; a hand-written config is a few hundred bytes, and
// anything much larger is generated code that the literal-mining below reads anyway.
const INLINE_PRINT_LIMIT = 4000;

const ENDPOINT_HINT = /(api|rest|service|adat|data|station|allomas|measure|meres|hidro|vizrajz|graphql|swagger|openapi|v1|v2)/i;

/**
 * Frames embedded by an HTML document.
 *
 * Portal software - MAVIR runs Liferay - composes a page out of portlets, and a chart
 * is often an iframe pointing at a separate application. Its own bundles are where the
 * data endpoint lives; the outer page only ever mentions the portal's own plumbing.
 */
function extractFrameUrls(html, pageUrl) {
  const urls = new Set();
  const patterns = [
    /<iframe[^>]+src=["']([^"']+)["']/gi,
    /<embed[^>]+src=["']([^"']+)["']/gi,
    /<object[^>]+data=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        urls.add(new URL(decodeHtml(match[1]), pageUrl).toString());
      } catch {
        /* malformed src, skip */
      }
    }
  }
  return [...urls];
}

/** Keep printed source visibly separate from the probe's own output. */
function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

/** Attribute values arrive HTML-escaped; &amp; in a query string breaks the request. */
function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[59];/g, "'");
}

/** Script and module URLs referenced by an HTML document, resolved against its base. */
function extractScriptUrls(html, pageUrl) {
  // Without a <base> tag, relative URLs resolve against the document's own URL - not
  // against the origin. Defaulting to '/' silently moved every relative script to the
  // site root, which is why a Swagger UI served from /vraquery/swagger/ reported its
  // bundles as /swagger-ui-bundle.js and every one of them 404'd.
  const baseAttr = (html.match(/<base[^>]+href=["']([^"']+)["']/i) || [])[1];
  const base = baseAttr ? new URL(decodeHtml(baseAttr), pageUrl).toString() : pageUrl;

  const urls = new Set();
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]+href=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+\.js)["']/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        urls.add(new URL(decodeHtml(match[1]), base).toString());
      } catch {
        /* malformed src, skip */
      }
    }
  }
  return [...urls];
}

/**
 * The contents of every `<script>` block that has no `src`.
 *
 * A generated API explorer keeps its configuration here, not in a downloadable file:
 * Swashbuckle and NSwag both emit an `index.html` whose inline script names the OpenAPI
 * document - `SwaggerUIBundle({url: "..."})`, or a `configObject` holding `urls`. Reading
 * only `<script src=...>` misses it entirely, which is why every guessed spec path 404'd
 * while the UI that loads one served fine.
 */
function extractInlineScripts(html) {
  const blocks = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue; // referenced separately
    const content = body.trim();
    if (content) blocks.push(content);
  }
  return blocks;
}

/**
 * String literals in a bundle that could be an endpoint.
 *
 * Minified code keeps its string literals intact, which is the whole reason this works.
 */
function extractCandidates(source, pageUrl) {
  const found = new Map(); // candidate -> occurrences

  const add = (raw) => {
    const value = raw.trim();
    if (!value || value.length > 200) return;
    if (!ENDPOINT_HINT.test(value)) return;
    // Skip the obvious non-endpoints that still match the hint.
    if (/\.(js|css|svg|png|jpe?g|woff2?|map|ico)$/i.test(value) && !/swagger|openapi/i.test(value)) return;
    if (/^(data|blob|javascript):/i.test(value)) return;
    found.set(value, (found.get(value) || 0) + 1);
  };

  // Absolute URLs.
  for (const m of source.matchAll(/https?:\/\/[^\s"'`<>\\)]{6,200}/g)) add(m[0]);
  // Quoted path-like literals.
  for (const m of source.matchAll(/["'`](\/[A-Za-z0-9_\-./{}$:]{3,150})["'`]/g)) add(m[1]);

  // Resolve relative paths against the page so they are directly callable.
  const resolved = new Map();
  for (const [value, count] of found) {
    try {
      resolved.set(value.startsWith('http') ? value : new URL(value, pageUrl).toString(), count);
    } catch {
      /* unresolvable, skip */
    }
  }
  return resolved;
}


/**
 * Print the code around a string literal.
 *
 * A candidate like `https://vmservice.vizugy.hu/vraquery/` is only the base - the rest
 * of the path is concatenated at runtime, so it never appears as a literal and probing
 * the base alone returns 404. The surrounding source shows how the full URL is built:
 * the method names, the parameters, the query string. Minified code is unreadable in
 * bulk but perfectly readable in a 600-character window around the interesting string.
 */
function dumpContext(sources, needle, { radius = 320, maxHits = 4 } = {}) {
  let hits = 0;

  for (const [url, source] of sources) {
    let index = source.indexOf(needle);
    while (index !== -1 && hits < maxHits) {
      const from = Math.max(0, index - radius);
      const to = Math.min(source.length, index + needle.length + radius);
      console.log(`\n  --- ${needle} in ${url.split('/').pop()} @${index} ---`);
      console.log(`  ${source.slice(from, to).replace(/\s+/g, ' ')}`);
      hits += 1;
      index = source.indexOf(needle, index + needle.length);
    }
    if (hits >= maxHits) break;
  }

  if (hits === 0) console.log(`\n  (${needle} not found as a literal)`);
  return hits;
}

/** Call a candidate and report what came back. */
async function testCandidate(url, headers = {}) {
  try {
    const { body, contentType } = await fetchText(url, { timeoutMs: 12000, retries: 0, headers });
    const trimmed = body.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    return {
      url,
      ok: true,
      isJson,
      contentType,
      bytes: body.length,
      preview: trimmed.slice(0, 200),
    };
  } catch (err) {
    return { url, ok: false, error: err.message.split('\n')[0] };
  }
}

async function discover(pageUrl, { probe = true, depth = 1, keywords = [], radius = 320 } = {}) {
  console.log(`\n########## discovering ${pageUrl} ##########`);

  // MAVIR's publication app serves its page but 403s every script it references - an
  // asset server checking where the request came from. A browser always says; a bare
  // fetch does not, so the page loads and the bundles that hold the endpoints do not.
  const origin = new URL(pageUrl).origin;
  const headers = browserHeaders(origin, pageUrl);

  let html;
  try {
    ({ body: html } = await fetchText(pageUrl, { timeoutMs: 20000, retries: 0, headers }));
  } catch (err) {
    console.log(`Could not load the page: ${err.message}`);
    return [];
  }

  const frames = extractFrameUrls(html, pageUrl);
  if (frames.length > 0) {
    console.log(`${frames.length} embedded frame(s):`);
    for (const f of frames) console.log(`  ${f}`);
  }

  const scripts = extractScriptUrls(html, pageUrl);
  console.log(`${scripts.length} script(s) referenced:`);
  for (const s of scripts) console.log(`  ${s}`);

  const candidates = new Map();
  const sources = new Map();

  // Inline scripts first. They are small, and on a generated API explorer they are the
  // only place the OpenAPI document is named - the referenced bundles are the stock
  // library, whose own string literals are all about the spec format, not this API.
  const inline = extractInlineScripts(html);
  if (inline.length > 0) {
    const totalBytes = inline.reduce((sum, block) => sum + block.length, 0);
    console.log(`${inline.length} inline script block(s), ${totalBytes} bytes:`);
    inline.forEach((block, i) => {
      sources.set(`${pageUrl}#inline-${i + 1}`, block);
      for (const [url, count] of extractCandidates(block, pageUrl)) {
        candidates.set(url, (candidates.get(url) || 0) + count);
      }
      // Short enough to read in full, and that is the point - the configuration is
      // usually four lines and no amount of literal-mining beats seeing it.
      console.log(`\n  --- inline #${i + 1} ---`);
      console.log(indent(block.slice(0, INLINE_PRINT_LIMIT)));
      if (block.length > INLINE_PRINT_LIMIT) {
        console.log(`  ... (${block.length - INLINE_PRINT_LIMIT} more bytes)`);
      }
    });
    console.log('');
  }

  for (const scriptUrl of scripts) {
    try {
      const { body } = await fetchText(scriptUrl, { timeoutMs: 30000, retries: 0, headers });
      if (body.length > MAX_SCRIPT_BYTES) {
        console.log(`  (skipped ${scriptUrl} - ${body.length} bytes)`);
        continue;
      }
      sources.set(scriptUrl, body);
      for (const [url, count] of extractCandidates(body, pageUrl)) {
        candidates.set(url, (candidates.get(url) || 0) + count);
      }
    } catch (err) {
      console.log(`  (failed ${scriptUrl}: ${err.message.split('\n')[0]})`);
    }
  }

  // Same-origin endpoints first - those are the app's own API.
  const ranked = [...candidates.entries()]
    .sort((a, b) => {
      const aSame = a[0].startsWith(origin) ? 1 : 0;
      const bSame = b[0].startsWith(origin) ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
      return b[1] - a[1];
    })
    .map(([url]) => url);

  console.log(`\n${ranked.length} endpoint candidate(s) found in the bundles:`);
  for (const url of ranked.slice(0, 40)) console.log(`  ${url}`);

  // Show how each candidate's URL is assembled. A base path that 404s on its own is
  // completed somewhere in this code, and the window around it says how.
  if (ranked.length > 0) {
    console.log('\nHow these URLs are built:');
    for (const url of ranked.slice(0, 6)) {
      const segment = url.replace(/\/+$/, '').split('/').filter(Boolean).pop();
      if (segment && segment.length >= 4) dumpContext(sources, segment, { radius });
    }
  }

  // Identifiers the caller already knows are interesting - the method that assembles
  // the request, rather than the base URL it starts from.
  if (keywords.length > 0) {
    console.log('\nRequested identifiers:');
    for (const keyword of keywords) dumpContext(sources, keyword, { radius: radius * 3, maxHits: 2 });
  }

  // A framed application is a separate app with its own bundles - follow it once.
  if (depth > 0) {
    for (const frame of frames) {
      await discover(frame, { probe, depth: depth - 1 });
    }
  }

  if (!probe || ranked.length === 0) return ranked;

  console.log(`\nCalling the top ${Math.min(MAX_PROBES, ranked.length)}...\n`);
  const hits = [];

  for (const url of ranked.slice(0, MAX_PROBES)) {
    // A templated path cannot be called as-is, but is worth reporting - it names the
    // parameter the real request needs.
    if (/[{}$]/.test(url)) {
      console.log(`TEMPLATE  ${url}`);
      continue;
    }

    const result = await testCandidate(url, headers);
    if (!result.ok) {
      console.log(`FAIL      ${url}  (${result.error})`);
    } else if (result.isJson) {
      console.log(`JSON      ${url}  (${result.bytes} bytes)`);
      console.log(`          ${result.preview.replace(/\s+/g, ' ').slice(0, 160)}`);
      hits.push(result);
    } else {
      console.log(`not-json  ${url}  (${result.contentType})`);
    }
  }

  if (hits.length > 0) {
    console.log(`\n${hits.length} endpoint(s) returned JSON - those are the ones to configure.`);
  } else {
    console.log('\nNothing returned JSON. The API may need a parameter, or the paths above are templates.');
  }

  return ranked;
}

module.exports = {
  discover,
  extractScriptUrls,
  extractInlineScripts,
  extractFrameUrls,
  extractCandidates,
  decodeHtml,
  dumpContext,
};
