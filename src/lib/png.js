'use strict';

const zlib = require('node:zlib');

/**
 * A PNG encoder, because the share card has to be a raster and this project will not
 * take a rasteriser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The site's og:image was an SVG for a year. It renders in Slack, Mastodon and Discord,
 * and the methodology said so honestly - but Facebook, X and LinkedIn do not render SVG
 * in a link preview at all. They accept PNG, JPEG, GIF and WebP and nothing else. So on
 * the three platforms where a link to this actually travels between people who are not
 * already reading it, the card was simply absent: a bare URL with no picture.
 *
 * The usual fix is a headless browser or an image library. Both are enormous next to a
 * project whose entire dependency list is express and pg, and neither runs in a Vercel
 * function without a great deal of arranging. Node ships zlib, which is the only hard
 * part of a PNG, so the encoder is about sixty lines and the whole thing costs nothing
 * at install time.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not a graphics library. There is no path filling, no antialiasing, no image
 * compositing and no font. It fills rectangles into an RGBA buffer and writes the buffer
 * out. Everything the card draws is built from rectangles for exactly that reason - see
 * the glyph and digit renderers next door, and the note in share.js about what that
 * constraint did to the card's design.
 */

/** True colour with alpha. The card is opaque, but alpha keeps blending simple. */
const CHANNELS = 4;

class Bitmap {
  constructor(width, height, background = [255, 255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * CHANNELS);
    this.fill(0, 0, width, height, background);
  }

  /**
   * Fill a rectangle. Clipped to the canvas, so a caller may draw off the edge.
   *
   * `colour` is [r, g, b] or [r, g, b, a]. A partial alpha blends with what is already
   * there, which is the whole of this encoder's compositing model and is enough for the
   * one thing the card needs it for: a tint band over the background gradient.
   */
  fill(x, y, w, h, colour) {
    const [r, g, b, a = 255] = colour;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0 || y1 <= y0 || a <= 0) return;

    for (let py = y0; py < y1; py += 1) {
      let i = (py * this.width + x0) * CHANNELS;
      for (let px = x0; px < x1; px += 1) {
        if (a >= 255) {
          this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
        } else {
          const t = a / 255;
          this.data[i] = Math.round(this.data[i] * (1 - t) + r * t);
          this.data[i + 1] = Math.round(this.data[i + 1] * (1 - t) + g * t);
          this.data[i + 2] = Math.round(this.data[i + 2] * (1 - t) + b * t);
          this.data[i + 3] = 255;
        }
        i += CHANNELS;
      }
    }
  }

  /**
   * A vertical gradient, one filled row at a time.
   *
   * Rows rather than a real gradient because a row is a rectangle and rectangles are all
   * this has. At 630 rows the banding is invisible.
   */
  verticalGradient(x, y, w, h, from, to) {
    for (let i = 0; i < h; i += 1) {
      const t = h <= 1 ? 0 : i / (h - 1);
      this.fill(x, y + i, w, 1, [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
      ]);
    }
  }

  /** PNG bytes. */
  toBuffer() {
    return encodePng(this.width, this.height, this.data);
  }
}

/* --- the file format ------------------------------------------------------ */

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Every scanline is prefixed with its filter type. Filter 0 (None) is used throughout:
  // the card is flat colour, so the filters that help photographs would cost CPU to save
  // very little, and zlib already collapses long runs of identical pixels to nothing.
  const stride = width * CHANNELS;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Standard PNG CRC-32, with the table built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { Bitmap, encodePng, crc32 };
