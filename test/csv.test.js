'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { toCsv, parseRange } = require('../src/lib/params');

test('a field containing a comma is quoted', () => {
  // One unquoted comma shifts every column after it, and the file still opens - which
  // is the worst kind of wrong, because nobody notices until the numbers are in print.
  const csv = toCsv(['a', 'b'], [{ a: 'Duna, Rajka', b: 5 }]);
  assert.match(csv, /"Duna, Rajka",5/);
});

test('a quote inside a field is doubled, not escaped with a backslash', () => {
  // RFC 4180 doubles it. A backslash is the C convention and Excel does not read it.
  const csv = toCsv(['a'], [{ a: 'a "quoted" name' }]);
  assert.match(csv, /"a ""quoted"" name"/);
  assert.doesNotMatch(csv, /\\"/);
});

test('a newline inside a field is quoted rather than breaking the row', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'line one\nline two', b: 1 }]);
  const [, ...rest] = csv.split('\r\n');
  assert.match(rest.join('\r\n'), /^"line one\nline two",1/);
});

test('null and undefined are empty, not the strings "null" and "undefined"', () => {
  // A literal "null" in a numeric column turns the whole column into text in Excel.
  const csv = toCsv(['a', 'b', 'c'], [{ a: null, b: undefined, c: 0 }]);
  assert.match(csv, /\r?\n,,0/);
});

test('rows are CRLF terminated, including the last', () => {
  const csv = toCsv(['a'], [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(csv, 'a\r\n1\r\n2\r\n');
});

test('an empty result is a header and nothing else', () => {
  // Not an empty body: a file with no header cannot be told from a failed download.
  assert.strictEqual(toCsv(['a', 'b'], []), 'a,b\r\n');
});

// ---------------------------------------------------------------------------
// days
// ---------------------------------------------------------------------------

test('days is honoured, and was silently ignored before', () => {
  // `?days=30` parsed as nothing and returned the 7-day default: a request that looks
  // honoured, answers 200, and is a quarter of what was asked for. The site's own chart
  // was doing exactly this.
  const r = parseRange({ days: '30' }, { defaultDays: 7 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(Math.round((r.toMs - r.fromMs) / 86400000), 30);
});

test('days and from together are refused rather than one silently winning', () => {
  const r = parseRange({ days: '30', from: '2026-01-01' }, { defaultDays: 7 });
  assert.match(r.error || '', /either 'days' or 'from'/);
});

test('a nonsense days value is an error, not a default', () => {
  assert.match(parseRange({ days: 'sok' }).error || '', /positive number/);
  assert.match(parseRange({ days: '-3' }).error || '', /positive number/);
});
