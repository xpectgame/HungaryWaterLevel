'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { readZip, readXlsx, parseSheet, parseSharedStrings, columnIndex, excelDate } = require('../src/lib/xlsx');

/**
 * The archives here are built byte by byte rather than checked in as fixtures.
 *
 * A committed .xlsx is opaque: when a test fails you cannot see what the input was, and
 * you cannot make a targeted change to it - a stored member, a comment, a name that
 * differs between the local and central headers - to test the branch that matters.
 * Building them makes each of those a one-line change.
 */

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A minimal ZIP writer: local headers, central directory, EOCD. */
function makeZip(files, { store = false, comment = '' } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    chunks.push(local, nameBuf, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([...chunks, centralBuf, eocd, commentBuf]);
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

test('a deflated member round-trips', () => {
  const zip = readZip(makeZip({ 'a.txt': 'hello', 'b/c.txt': 'world' }));
  assert.deepStrictEqual([...zip.keys()], ['a.txt', 'b/c.txt']);
  assert.strictEqual(zip.get('a.txt')().toString(), 'hello');
  assert.strictEqual(zip.get('b/c.txt')().toString(), 'world');
});

test('a stored member is read without inflating', () => {
  // Small files are often stored rather than deflated, and inflateRaw on stored bytes
  // throws rather than returning them.
  const zip = readZip(makeZip({ 'a.txt': 'hello' }, { store: true }));
  assert.strictEqual(zip.get('a.txt')().toString(), 'hello');
});

test('the end-of-directory record is found behind a trailing comment', () => {
  // The EOCD is not at the end of the file when a comment follows it, so reading the
  // last 22 bytes finds nothing.
  const zip = readZip(makeZip({ 'a.txt': 'hi' }, { comment: 'x'.repeat(300) }));
  assert.strictEqual(zip.get('a.txt')().toString(), 'hi');
});

test('a file that is not a ZIP says so instead of reading garbage', () => {
  assert.throws(() => readZip(Buffer.from('<html>not a spreadsheet</html>')), /Not a ZIP/);
});

test('members are decompressed on demand, not all at once', () => {
  // The workbook holds sheets this project never reads; inflating them on open would
  // be work done for nothing on every poll.
  const zip = readZip(makeZip({ 'a.txt': 'x', 'big.txt': 'y'.repeat(5000) }));
  assert.strictEqual(typeof zip.get('big.txt'), 'function');
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1902.5</v></c></row>
  <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>7</v></c></row>
</sheetData></worksheet>`;

const SHARED = `<?xml version="1.0"?><sst>
  <si><t>Időpont</t></si>
  <si><t>Paks</t></si>
  <si><t>2026-08-08 12:00</t></si>
  <si><t>Mátra &amp; Bükkábrány</t></si>
</sst>`;

const WORKBOOK = makeZip({
  '[Content_Types].xml': '<Types/>',
  'xl/sharedStrings.xml': SHARED,
  'xl/worksheets/sheet1.xml': SHEET,
});

test('text cells resolve through the shared string table', () => {
  // Without it a sheet reads as a grid of small integers where the labels should be.
  const { rows } = readXlsx(WORKBOOK);
  assert.deepStrictEqual(rows[0], ['Időpont', 'Paks']);
  assert.strictEqual(rows[1][0], '2026-08-08 12:00');
});

test('numbers stay numbers', () => {
  const { rows } = readXlsx(WORKBOOK);
  assert.strictEqual(rows[1][1], 1902.5);
});

test('a skipped cell holds its column rather than closing the gap', () => {
  // Row 3 has A and C but no B. Collapsing the gap would move C's value into B and
  // silently attribute one plant's output to another.
  const { rows } = readXlsx(WORKBOOK);
  assert.deepStrictEqual(rows[2], ['Mátra & Bükkábrány', null, 7]);
});

test('XML entities in labels are decoded', () => {
  const { rows } = readXlsx(WORKBOOK);
  assert.strictEqual(rows[2][0], 'Mátra & Bükkábrány');
});

test('a string split across styled runs is joined', () => {
  // Excel splits a cell into runs when part of it is formatted differently; taking the
  // first <t> alone truncates the name.
  const strings = parseSharedStrings('<sst><si><r><t>Duna</t></r><r><t>újváros</t></r></si></sst>');
  assert.deepStrictEqual(strings, ['Dunaújváros']);
});

test('inline strings are read without a shared table', () => {
  const rows = parseSheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Paks</t></is></c></row>');
  assert.deepStrictEqual(rows[0], ['Paks']);
});

test('an empty self-closed cell is null, not zero', () => {
  // Zero megawatts means a plant is off; unknown means the sheet did not say.
  const rows = parseSheet('<row r="1"><c r="A1"/><c r="B1"><v>5</v></c></row>');
  assert.deepStrictEqual(rows[0], [null, 5]);
});

test('column references beyond Z are decoded', () => {
  assert.strictEqual(columnIndex('A1'), 0);
  assert.strictEqual(columnIndex('Z9'), 25);
  assert.strictEqual(columnIndex('AA1'), 26);
  assert.strictEqual(columnIndex('BC12'), 54);
});

test('a workbook with no worksheet fails loudly', () => {
  assert.throws(() => readXlsx(makeZip({ 'xl/sharedStrings.xml': SHARED })), /No worksheet/);
});

test('sheets are ordered numerically, not lexically', () => {
  // sheet10 sorts before sheet2 as a string, so the "first" sheet would be the tenth.
  const workbook = makeZip({
    'xl/worksheets/sheet10.xml': '<row r="1"><c r="A1"><v>10</v></c></row>',
    'xl/worksheets/sheet2.xml': '<row r="1"><c r="A1"><v>2</v></c></row>',
    'xl/worksheets/sheet1.xml': '<row r="1"><c r="A1"><v>1</v></c></row>',
  });
  assert.strictEqual(readXlsx(workbook).rows[0][0], 1);
});

test('an Excel serial date lands on the right day', () => {
  // The epoch is 1899-12-30, not 1900-01-01: Excel keeps a phantom 29 February 1900,
  // so counting from the documented epoch is a day out for every real date.
  assert.strictEqual(excelDate(45877).toISOString().slice(0, 10), '2025-08-08');
  assert.strictEqual(excelDate(null), null);
});
