'use strict';

/**
 * Two ways of drawing text with rectangles, because the PNG encoder next door has no
 * font and no path filling.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT SHAPED THE CARD, AND THAT IS FINE
 * ---------------------------------------------------------------------------
 * A 5x7 bitmap letter scaled to 150px is unreadable - it stops being a letter and
 * becomes a pile of squares. So the card does not do that. It uses two renderers with
 * different jobs:
 *
 *   - `drawText` for labels, at sizes where a 5x7 cell still reads as type (up to about
 *     scale 5, which is 35px tall). Small pixel type is legible and looks deliberate;
 *     it is what a measuring instrument's screen looks like.
 *
 *   - `drawNumber` for the headline figure, as SEVEN SEGMENTS. Segments are rectangles,
 *     so they stay perfectly crisp at any size, and a large seven-segment number on a
 *     card about river gauges reads as the gauge itself rather than as a compromise.
 *
 * The design follows the tool rather than fighting it. A card that tried to be a
 * typographic layout with this renderer would look like a broken web page; a card that
 * looks like an instrument panel looks like it meant to.
 */

/* --- 5x7 bitmap font ------------------------------------------------------ */

/**
 * Each glyph is seven rows of five bits, most significant bit on the left.
 *
 * Lower case is a real lower case rather than small capitals: "Ennyi víz lép be" in
 * small caps reads as shouting, and the descenders on p, y and g are most of what makes
 * a line of text scannable.
 */
const FONT = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x04, 0x04, 0x04, 0x04, 0x00, 0x04, 0x00],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '*': [0x00, 0x0a, 0x04, 0x1f, 0x04, 0x0a, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'M': [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  'Q': [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'S': [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  'a': [0x00, 0x00, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  'b': [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x1e],
  'c': [0x00, 0x00, 0x0e, 0x11, 0x10, 0x11, 0x0e],
  'd': [0x01, 0x01, 0x0f, 0x11, 0x11, 0x11, 0x0f],
  'e': [0x00, 0x00, 0x0e, 0x11, 0x1f, 0x10, 0x0e],
  'f': [0x06, 0x09, 0x08, 0x1c, 0x08, 0x08, 0x08],
  // The five descenders carry two extra rows. They were first defined as seven rows
  // shifted up by one, which is the obvious way to fit a tail into a 7-row cell and it
  // looks exactly as wrong as it sounds: the bowl of the y sits above the x-height of
  // the n beside it, and "Ennyi" renders as "EnnYi". They descend properly now.
  'g': [0x00, 0x00, 0x0f, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e],
  'h': [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x11],
  'i': [0x04, 0x00, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  'j': [0x00, 0x02, 0x00, 0x06, 0x02, 0x02, 0x02, 0x12, 0x0c],
  'k': [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  'l': [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'm': [0x00, 0x00, 0x1a, 0x15, 0x15, 0x15, 0x15],
  'n': [0x00, 0x00, 0x1e, 0x11, 0x11, 0x11, 0x11],
  'o': [0x00, 0x00, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  'p': [0x00, 0x00, 0x1e, 0x11, 0x11, 0x11, 0x1e, 0x10, 0x10],
  'q': [0x00, 0x00, 0x0f, 0x11, 0x11, 0x11, 0x0f, 0x01, 0x01],
  'r': [0x00, 0x00, 0x16, 0x19, 0x10, 0x10, 0x10],
  's': [0x00, 0x00, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
  't': [0x08, 0x08, 0x1c, 0x08, 0x08, 0x09, 0x06],
  'u': [0x00, 0x00, 0x11, 0x11, 0x11, 0x13, 0x0d],
  'v': [0x00, 0x00, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'w': [0x00, 0x00, 0x11, 0x11, 0x15, 0x15, 0x0a],
  'x': [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  'y': [0x00, 0x00, 0x11, 0x11, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  'z': [0x00, 0x00, 0x1f, 0x02, 0x04, 0x08, 0x1f],
  '…': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x15],
  '·': [0x00, 0x00, 0x00, 0x0c, 0x0c, 0x00, 0x00],
  '³': [0x1c, 0x02, 0x0c, 0x02, 0x1c, 0x00, 0x00],
  '×': [0x00, 0x00, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  '–': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '—': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
};

/**
 * The Hungarian vowels, as a base letter plus a mark.
 *
 * Drawn rather than defined, because eighteen more glyph tables to say "o with two
 * strokes over it" is eighteen more places to make a typo, and because the marks then
 * sit at a consistent height across every letter that takes one. Hungarian needs all
 * three marks - and the double acute on ő and ű is not a diaeresis, which is a
 * distinction native readers notice immediately.
 */
const MARKS = {
  á: ['a', 'acute'], é: ['e', 'acute'], í: ['i', 'acute'], ó: ['o', 'acute'],
  ú: ['u', 'acute'], ö: ['o', 'umlaut'], ü: ['u', 'umlaut'],
  ő: ['o', 'double'], ű: ['u', 'double'],
  Á: ['A', 'acute'], É: ['E', 'acute'], Í: ['I', 'acute'], Ó: ['O', 'acute'],
  Ú: ['U', 'acute'], Ö: ['O', 'umlaut'], Ü: ['U', 'umlaut'],
  Ő: ['O', 'double'], Ű: ['U', 'double'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
/* Two rows above the cell for the mark, so an accented line is not taller than an
   unaccented one - the baseline stays put and only the space above it is used. */
const MARK_ROWS = 2;

/**
 * Draw one line of text. Returns the width drawn, so a caller can lay out inline runs
 * without measuring twice.
 *
 * `y` is the top of the glyph cell, not the baseline: there is no baseline metric in a
 * bitmap this size and pretending otherwise invites off-by-one drift.
 */
function drawText(bmp, text, x, y, scale, colour, { letterSpacing = 1, maxWidth } = {}) {
  // Trim to fit rather than run off the edge. The first version of the card had three
  // lines disappear past the right margin - "(augusztusi mediá" and nothing after it -
  // which is the failure mode a fixed-width renderer has instead of wrapping, and it is
  // invisible until somebody looks at the image.
  const body = maxWidth ? fitText(text, scale, maxWidth, { letterSpacing }) : String(text);

  let cx = x;
  for (const ch of body) {
    const mark = MARKS[ch];
    const base = mark ? mark[0] : ch;
    const rows = FONT[base] !== undefined ? FONT[base] : FONT['?'];

    // `rows.length`, not GLYPH_H: the five descenders are nine rows and the last two are
    // the tail. A fixed 7 here silently clips them and the fix above does nothing.
    for (let ry = 0; ry < rows.length; ry += 1) {
      const bits = rows[ry];
      for (let rx = 0; rx < GLYPH_W; rx += 1) {
        if (bits & (1 << (GLYPH_W - 1 - rx))) {
          bmp.fill(cx + rx * scale, y + (ry + MARK_ROWS) * scale, scale, scale, colour);
        }
      }
    }

    if (mark) drawMark(bmp, mark[1], cx, y, scale, colour);
    cx += (GLYPH_W + letterSpacing) * scale;
  }
  return cx - x;
}

function drawMark(bmp, kind, x, y, scale, colour) {
  // Sits in the two rows above the cell. `acute` leans, which at this size means one
  // square offset - enough to tell it from the umlaut at a glance.
  if (kind === 'acute') {
    bmp.fill(x + 3 * scale, y, scale, scale, colour);
    bmp.fill(x + 2 * scale, y + scale, scale, scale, colour);
  } else if (kind === 'umlaut') {
    bmp.fill(x + scale, y, scale, scale, colour);
    bmp.fill(x + 3 * scale, y, scale, scale, colour);
  } else if (kind === 'double') {
    bmp.fill(x + 2 * scale, y, scale, scale, colour);
    bmp.fill(x + scale, y + scale, scale, scale, colour);
    bmp.fill(x + 4 * scale, y, scale, scale, colour);
    bmp.fill(x + 3 * scale, y + scale, scale, scale, colour);
  }
}

/** What `drawText` would occupy, without drawing it. */
function textWidth(text, scale, { letterSpacing = 1 } = {}) {
  return [...String(text)].length * (GLYPH_W + letterSpacing) * scale;
}

/**
 * The longest prefix of `text` that fits, with an ellipsis when anything was dropped.
 *
 * Cuts at a word boundary where there is one within reach, because "a szokásos…" reads
 * as trimmed and "a szoká…" reads as broken.
 */
function fitText(text, scale, maxWidth, { letterSpacing = 1 } = {}) {
  const s = String(text);
  if (textWidth(s, scale, { letterSpacing }) <= maxWidth) return s;

  const cell = (GLYPH_W + letterSpacing) * scale;
  const fits = Math.max(0, Math.floor(maxWidth / cell) - 1);
  if (fits <= 0) return '';

  const chars = [...s];
  let cut = chars.slice(0, fits).join('');
  const space = cut.lastIndexOf(' ');
  if (space > fits * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[ ,(]+$/, '')}…`;
}

const TEXT_HEIGHT = (GLYPH_H + MARK_ROWS) * 1;
const textHeight = (scale) => (GLYPH_H + MARK_ROWS) * scale;

/* --- seven-segment numerals ----------------------------------------------- */

/*
 *      aaaa
 *     f    b
 *     f    b
 *      gggg
 *     e    c
 *     e    c
 *      dddd
 */
const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd',
};

/**
 * A number, in segments, at any size and perfectly crisp.
 *
 * Digits only, plus the separators Hungarian numbers actually use - a space for
 * thousands and a comma for the decimal. Anything else is skipped rather than drawn as a
 * wrong glyph.
 */
function drawNumber(bmp, text, x, y, height, colour, { thickness, gap } = {}) {
  const t = thickness || Math.max(2, Math.round(height * 0.13));
  const w = height * 0.56;
  const step = w + t * 2.4;
  const space = gap === undefined ? t * 1.4 : gap;
  let cx = x;

  for (const ch of String(text)) {
    if (ch >= '0' && ch <= '9') {
      const on = SEGMENTS[Number(ch)];
      const mid = y + (height - t) / 2;
      if (on.includes('a')) bmp.fill(cx, y, w, t, colour);
      if (on.includes('g')) bmp.fill(cx, mid, w, t, colour);
      if (on.includes('d')) bmp.fill(cx, y + height - t, w, t, colour);
      if (on.includes('f')) bmp.fill(cx, y, t, (height + t) / 2, colour);
      if (on.includes('b')) bmp.fill(cx + w - t, y, t, (height + t) / 2, colour);
      if (on.includes('e')) bmp.fill(cx, mid, t, (height + t) / 2, colour);
      if (on.includes('c')) bmp.fill(cx + w - t, mid, t, (height + t) / 2, colour);
      cx += step;
    } else if (ch === ',') {
      bmp.fill(cx, y + height - t, t, t, colour);
      bmp.fill(cx, y + height, t, t, colour);
      cx += t * 2.2;
    } else if (ch === '.') {
      bmp.fill(cx, y + height - t, t, t, colour);
      cx += t * 2.2;
    } else if (ch === ' ' || ch === ' ' || ch === ' ') {
      // Hungarian groups thousands with a space, and the locale formatter emits a
      // non-breaking or narrow one depending on the runtime. All three are the same gap.
      cx += space + t;
    } else if (ch === '-' || ch === '–') {
      bmp.fill(cx, y + (height - t) / 2, w, t, colour);
      cx += step;
    }
  }
  return cx - x;
}

/** What `drawNumber` would occupy. Same walk, no drawing. */
function numberWidth(text, height, { thickness, gap } = {}) {
  const t = thickness || Math.max(2, Math.round(height * 0.13));
  const w = height * 0.56;
  const step = w + t * 2.4;
  const space = gap === undefined ? t * 1.4 : gap;
  let cx = 0;
  for (const ch of String(text)) {
    if ((ch >= '0' && ch <= '9') || ch === '-' || ch === '–') cx += step;
    else if (ch === ',' || ch === '.') cx += t * 2.2;
    else if (ch === ' ' || ch === ' ' || ch === ' ') cx += space + t;
  }
  return cx;
}

module.exports = {
  drawText, textWidth, textHeight, TEXT_HEIGHT, fitText,
  drawNumber, numberWidth, FONT, MARKS, GLYPH_W, GLYPH_H, MARK_ROWS,
};
