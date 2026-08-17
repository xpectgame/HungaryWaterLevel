'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { Bitmap, crc32 } = require('../src/lib/png');
const {
  drawText, drawNumber, numberWidth, textWidth, fitText, FONT, MARKS,
} = require('../src/lib/glyphs');

/* --- the encoder ---------------------------------------------------------- */

test('the output is a PNG a decoder would accept', () => {
  const png = new Bitmap(8, 4, [10, 20, 30, 255]).toBuffer();
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.slice(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.slice(-8, -4).toString('ascii'), 'IEND');
});

test('the header describes the image it actually wrote', () => {
  const png = new Bitmap(37, 11).toBuffer();
  assert.equal(png.readUInt32BE(16), 37);
  assert.equal(png.readUInt32BE(20), 11);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'colour type: truecolour with alpha');
});

test('every chunk carries a correct CRC', () => {
  // A wrong CRC is the failure that looks like nothing locally and renders as a broken
  // image everywhere else, because most decoders check it and most viewers do not say so.
  const png = new Bitmap(6, 6, [1, 2, 3]).toBuffer();
  let at = 8;
  let chunks = 0;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const body = png.slice(at + 4, at + 8 + length);
    const stored = png.readUInt32BE(at + 8 + length);
    assert.equal(crc32(body), stored, `bad CRC on ${png.slice(at + 4, at + 8).toString('ascii')}`);
    at += 12 + length;
    chunks += 1;
  }
  assert.equal(chunks, 3, 'IHDR, IDAT, IEND');
});

test('the pixels survive the round trip', () => {
  const bmp = new Bitmap(4, 2, [0, 0, 0, 255]);
  bmp.fill(1, 0, 2, 1, [255, 128, 64]);
  const png = bmp.toBuffer();

  // Pull the IDAT back out and inflate it, so this checks the bytes rather than the API.
  const length = png.readUInt32BE(33);
  const idat = png.slice(41, 41 + length);
  const raw = zlib.inflateSync(idat);

  const stride = 4 * 4;
  assert.equal(raw.length, (stride + 1) * 2);
  assert.equal(raw[0], 0, 'filter byte: None');
  assert.deepEqual([...raw.slice(5, 8)], [255, 128, 64], 'the filled pixel');
  assert.deepEqual([...raw.slice(1, 4)], [0, 0, 0], 'and the one beside it is untouched');
});

test('drawing outside the canvas is clipped, not a crash or a wrap', () => {
  const bmp = new Bitmap(4, 4, [0, 0, 0]);
  bmp.fill(-10, -10, 3, 3, [255, 255, 255]);
  bmp.fill(20, 20, 5, 5, [255, 255, 255]);
  bmp.fill(2, 2, 100, 100, [9, 9, 9]);
  const png = bmp.toBuffer();
  assert.ok(png.length > 0);
});

test('a partial alpha blends instead of replacing', () => {
  const bmp = new Bitmap(1, 1, [0, 0, 0, 255]);
  bmp.fill(0, 0, 1, 1, [255, 255, 255, 128]);
  assert.ok(bmp.data[0] > 100 && bmp.data[0] < 155, `got ${bmp.data[0]}, expected about half`);
});

/* --- the glyphs ----------------------------------------------------------- */

test('every glyph is five bits wide and never taller than its cell', () => {
  for (const [ch, rows] of Object.entries(FONT)) {
    assert.ok(rows.length === 7 || rows.length === 9, `${ch} has ${rows.length} rows`);
    for (const bits of rows) {
      assert.ok(bits >= 0 && bits <= 0x1f, `${ch} has a row outside five bits: ${bits}`);
    }
  }
});

test('the descenders descend rather than sitting a row high', () => {
  // The first version fitted the tail by shifting the whole glyph up one row, which puts
  // the bowl of the y above the x-height of the n beside it: "Ennyi" rendered "EnnYi".
  for (const ch of ['g', 'j', 'p', 'q', 'y']) {
    assert.equal(FONT[ch].length, 9, `${ch} should have two descender rows`);
    assert.ok(FONT[ch][7] || FONT[ch][8], `${ch} has no tail`);
    // Rows 0 and 1 sit above the x-height, so they are empty on every descender except
    // the j, whose tittle belongs there - a j without its dot is an i with a tail.
    assert.equal(FONT[ch][0], 0, `${ch} pokes above the ascender line`);
    if (ch === 'j') assert.notEqual(FONT[ch][1], 0, 'the j has lost its tittle');
    else assert.equal(FONT[ch][1], 0, `${ch} pokes above the x-height`);
  }
});

test('every accented vowel Hungarian needs resolves to a base glyph and a mark', () => {
  const needed = 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ';
  for (const ch of needed) {
    const mark = MARKS[ch];
    assert.ok(mark, `${ch} is not mapped`);
    assert.ok(FONT[mark[0]], `${ch} maps to a base glyph that does not exist: ${mark[0]}`);
    assert.ok(['acute', 'umlaut', 'double'].includes(mark[1]), `${ch} has an unknown mark`);
  }
  // ő and ű take a DOUBLE acute, not a diaeresis. Getting this wrong is the single most
  // visible way to look like you do not speak the language.
  assert.equal(MARKS['ő'][1], 'double');
  assert.equal(MARKS['ű'][1], 'double');
  assert.equal(MARKS['ö'][1], 'umlaut');
});

test('the card text uses only glyphs that exist', () => {
  // An unmapped character silently renders as "?", which on a share card is a typo
  // nobody sees until it is on somebody's timeline.
  const used = 'HOVAFOLYIK.HU Ennyi víz lép be ma a határon m³/s az ilyenkor szokásosnak '
    + '(augusztusi medián) az éves átlagnak nincs összehasonlítási alap erre a hónapra '
    + 'Távozik határszelvény élő mérése Forrás: OVF frissítve januári februári márciusi '
    + 'áprilisi májusi júniusi júliusi szeptemberi októberi novemberi decemberi 0123456789%·…';
  for (const ch of used) {
    assert.ok(FONT[ch] !== undefined || MARKS[ch] !== undefined, `no glyph for ${JSON.stringify(ch)}`);
  }
});

test('text is trimmed to fit rather than run off the edge', () => {
  const long = 'az ilyenkor szokásosnak (augusztusi medián)';
  const fitted = fitText(long, 3, 400);
  assert.ok(fitted.length < long.length);
  assert.ok(fitted.endsWith('…'));
  assert.ok(textWidth(fitted, 3) <= 400, 'the trimmed string still does not fit');
  // A string that fits is returned untouched, with no ellipsis bolted on.
  assert.equal(fitText('rövid', 3, 400), 'rövid');
});

test('a measured number and a drawn number agree on width', () => {
  // The unit label is positioned from numberWidth. If the two walks disagree, "m³/s"
  // lands on top of the last digit - which is exactly the bug the SVG card had and
  // fixed with a tspan that is not available to this renderer.
  const bmp = new Bitmap(1400, 300, [255, 255, 255]);
  for (const value of ['3 169', '1 249', '0,09', '58', '2 569']) {
    const drawn = drawNumber(bmp, value, 10, 10, 100, [0, 0, 0]);
    const measured = numberWidth(value, 100);
    assert.ok(Math.abs(drawn - measured) < 0.001, `${value}: drew ${drawn}, measured ${measured}`);
  }
});

test('the thousands separator is handled whichever space the runtime emits', () => {
  // hu-HU formatting produces a non-breaking or narrow space depending on the ICU
  // build, and a separator this code does not recognise collapses the number to
  // "3169" or drops the group entirely.
  const plain = numberWidth('3 169', 100);
  const nbsp = numberWidth('3 169', 100);
  const narrow = numberWidth('3 169', 100);
  assert.equal(plain, nbsp);
  assert.equal(plain, narrow);
  assert.ok(plain > numberWidth('3169', 100), 'the group gap must be wider than no gap');
});

test('drawText reports the width it drew, for laying out a run inline', () => {
  const bmp = new Bitmap(400, 60, [255, 255, 255]);
  const w = drawText(bmp, '127%', 10, 10, 4, [0, 0, 0]);
  assert.equal(w, textWidth('127%', 4));
});
