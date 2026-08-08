'use strict';

const zlib = require('node:zlib');

/**
 * Just enough of ZIP and XLSX to read one spreadsheet.
 *
 * MAVIR publishes its per-plant generation as an .xlsx download and nothing else - no
 * csv, no JSON, and the chart itself is a server-rendered image. So reading a
 * spreadsheet is not a preference here; it is the only way to get the numbers.
 *
 * A dependency would be the obvious answer, and the whole project runs on express and
 * pg. A spreadsheet parser is a large amount of code to trust for one file from one
 * source, and what is actually needed is small: inflate a few members of a ZIP, read
 * two XML files, return a grid. That fits in this file and can be tested end to end.
 *
 * What it does NOT do: styles, formulas, dates as dates, multiple sheets by name,
 * ZIP64, or encryption. Anything beyond one flat sheet of numbers and strings should
 * use a real library rather than growing this one.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

// A ZIP comment can be 64 KB; the record sits just before it.
const MAX_EOCD_SEARCH = 66 * 1024;

/**
 * Members of a ZIP archive, by name.
 *
 * The central directory is read rather than the local headers scanned, because a local
 * header may declare sizes of zero and defer them to a trailing data descriptor - in
 * which case scanning forward reads an empty file and reports no error at all.
 */
function readZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error('Not a ZIP archive: no end-of-central-directory record');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const files = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP: central directory entry ${i} has a bad signature`);
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    files.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const result = new Map();
  for (const [name, entry] of files) {
    result.set(name, () => inflateEntry(buffer, entry));
  }
  return result;
}

function findEocd(buffer) {
  const from = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function inflateEntry(buffer, { method, compressedSize, localOffset }) {
  if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('Corrupt ZIP: local header has a bad signature');
  }

  // The local header's own name and extra lengths, not the central directory's - the
  // two are allowed to differ, and the data starts after the local copy.
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + compressedSize);

  if (method === 0) return raw; // stored
  if (method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${method}`);
}

/** Undo the five XML entities that matter, and numeric character references. */
function decodeXml(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The shared string table.
 *
 * Every text cell in a sheet is an index into this, not a string - which is why a sheet
 * read on its own comes back as a grid of small integers where the labels should be.
 * A string can be split across several runs when parts of it are styled differently,
 * so all the <t> elements inside one <si> are concatenated.
 */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];

  for (const [, item] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const [, run] of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += run;
    strings.push(decodeXml(text));
  }

  // A single-run <si> may be written as <si><t>x</t></si> or self-closed when empty.
  return strings;
}

/** "BC12" -> 54. Column letters are base-26 with no zero. */
function columnIndex(reference) {
  const letters = (reference.match(/^[A-Z]+/) || [''])[0];
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * One worksheet as an array of rows, each an array of values.
 *
 * Empty cells are preserved as null rather than skipped: a sheet omits them entirely,
 * and collapsing the gap shifts every later column into the wrong place.
 */
function parseSheet(xml, sharedStrings = []) {
  const rows = [];

  for (const [, rowXml] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];

    // The attribute run is lazy and the slash is consumed by the alternation. Greedy,
    // `[^>]*` swallows the closing "/" of a self-closed cell, the ">" branch then
    // matches, and two cells are read as one - which drops the empty cell and shifts
    // every value after it one column left.
    for (const match of rowXml.matchAll(/<c\b([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = match[1] || '';
      const body = match[2] || '';

      const reference = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';

      let value = null;
      if (type === 'inlineStr') {
        let text = '';
        for (const [, run] of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += run;
        value = decodeXml(text);
      } else {
        const raw = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (raw !== undefined) {
          if (type === 's') value = sharedStrings[Number(raw)] ?? null;
          else if (type === 'str' || type === 'e') value = decodeXml(raw);
          else if (type === 'b') value = raw === '1';
          else {
            const number = Number(raw);
            value = Number.isFinite(number) ? number : decodeXml(raw);
          }
        }
      }

      const at = reference ? columnIndex(reference) : cells.length;
      while (cells.length < at) cells.push(null);
      cells[at] = value;
    }

    rows.push(cells);
  }

  return rows;
}

/**
 * Read the first worksheet of an xlsx buffer into a grid.
 *
 * Sheet order in the archive is not the workbook's order, so the sheet is taken by its
 * file name rather than by whichever member happens to come first.
 */
function readXlsx(buffer) {
  const zip = readZip(buffer);

  const read = (name) => {
    const entry = zip.get(name);
    return entry ? entry().toString('utf8') : null;
  };

  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));

  const sheetNames = [...zip.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  if (sheetNames.length === 0) throw new Error('No worksheet found in the workbook');

  return {
    sheetCount: sheetNames.length,
    rows: parseSheet(read(sheetNames[0]), sharedStrings),
  };
}

/**
 * An Excel serial date as a JavaScript Date, in UTC.
 *
 * The epoch is 1899-12-30, not 1900-01-01: Excel treats 1900 as a leap year for
 * compatibility with a bug in Lotus 1-2-3, so counting from the documented epoch lands
 * a day out for every date after February 1900 - which is all of them.
 */
function excelDate(serial) {
  if (!Number.isFinite(serial)) return null;
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

module.exports = { readZip, readXlsx, parseSheet, parseSharedStrings, columnIndex, excelDate, decodeXml };
