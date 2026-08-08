'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { fetchText, fetchJson, describeCause, browserHeaders } = require('../src/lib/http');

/**
 * These run against a real loopback server rather than a stubbed fetch.
 *
 * The bug that prompted them was invisible to a stub: adding a `body` option to
 * fetchText shadowed the response body inside the same block, so every call - GET
 * included - threw "Cannot access 'body' before initialization" the moment it reached
 * the fetch. Only actually calling the function through to a response catches that.
 */

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await run(base);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('a plain GET returns the body and content type', () =>
  withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    async (base) => {
      const { body, contentType } = await fetchText(`${base}/x`);
      assert.strictEqual(body, '{"ok":true}');
      assert.match(contentType, /application\/json/);
    },
  ));

test('a POST sends its body and method', () =>
  withServer(
    (req, res) => {
      let received = '';
      req.on('data', (chunk) => {
        received += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, echo: JSON.parse(received || 'null') }));
      });
    },
    async (base) => {
      const payload = [{ ItemId: 1, Torzsszam: 1, AdatFajtaKod: 87 }];
      const response = await fetchJson(`${base}/TS/TsShort`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      assert.strictEqual(response.method, 'POST');
      assert.deepStrictEqual(response.echo, payload);
    },
  ));

test('a non-JSON response is reported as such rather than as a parse error', () =>
  withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>maintenance</html>');
    },
    async (base) => {
      await assert.rejects(() => fetchJson(base), /Expected JSON/);
    },
  ));

test('a 404 carries its status and is not retried into a timeout', () =>
  withServer(
    (req, res) => {
      res.writeHead(404);
      res.end('nope');
    },
    async (base) => {
      await assert.rejects(
        () => fetchText(base),
        (err) => err.status === 404 && /HTTP 404/.test(err.message),
      );
    },
  ));

test('the cause chain is unwrapped into the message', () => {
  const inner = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const outer = Object.assign(new Error('fetch failed'), { cause: inner });
  assert.match(describeCause(outer), /fetch failed <- ECONNREFUSED \[ECONNREFUSED\]/);
});

test('a cycle in the cause chain terminates', () => {
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b;
  b.cause = a;
  assert.match(describeCause(a), /a <- b/);
});

test('browser headers name the origin they were built for', () => {
  const headers = browserHeaders('https://data.vizugy.hu');
  assert.strictEqual(headers.Origin, 'https://data.vizugy.hu');
  assert.strictEqual(headers.Referer, 'https://data.vizugy.hu/');
});
