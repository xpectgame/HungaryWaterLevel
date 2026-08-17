'use strict';

const express = require('express');
const { computeBalance } = require('../domain/balance');
const { monthlyMedian } = require('../domain/flow-history');
const { getStation } = require('../config/stations');
const { asyncRoute } = require('../lib/async-route');
const { Bitmap } = require('../lib/png');
const { drawText, drawNumber, numberWidth } = require('../lib/glyphs');

/**
 * The two things that decide whether this project spreads: what a pasted link looks
 * like, and whether a newsroom can put a piece of it inside their own article.
 *
 * ---------------------------------------------------------------------------
 * PNG AND SVG, AND THE PNG IS THE ONE THAT COUNTS
 * ---------------------------------------------------------------------------
 * This started as SVG only, with a note saying that Facebook and LinkedIn would not
 * render it and that Slack, Mastodon and Discord would. That was true and it was still
 * the wrong trade: the three platforms that do not take SVG are the three where a link
 * travels to people who are not already reading the site, and on all of them the card
 * was simply absent - a bare URL, no picture.
 *
 * So there is a PNG now, rendered by src/lib/png.js and src/lib/glyphs.js: about two
 * hundred lines, no dependency, no headless browser. Node ships zlib, which is the only
 * hard part of a PNG.
 *
 * The renderer has no font and no path filling, only rectangles, and the card's design
 * follows from that rather than fighting it. The headline figure is drawn in seven
 * segments - rectangles, so crisp at any size - and the labels in a 5x7 bitmap face at
 * sizes where pixel type still reads as type. A card about river gauges that looks like
 * a gauge is a legitimate design; a card that tried to be a typographic layout with this
 * renderer would just look broken.
 *
 * The SVG stays, at its old URL, because it is sharper where it renders and some feeds
 * still ask for it. The og:image points at the PNG.
 *
 * Both endpoints are cached hard at the edge. A share card is fetched by a crawler, once
 * per paste, and an embed sits on someone else's page: neither should reach the poller.
 */

const W = 1200;
const H = 630;

module.exports = function shareRoutes(ctx) {
  const router = express.Router();
  const { store, config } = ctx;

  async function balanceNow() {
    const readings = await store.latestReadings(config.maxReadingAgeMs);
    return computeBalance(readings, { method: 'instant' });
  }

  /** GET /share/card.svg - the national balance as a picture. */
  router.get('/share/card.svg', asyncRoute(async (req, res) => {
    const b = await balanceNow();
    res.type('image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=900, s-maxage=900');
    res.send(nationalCard(b));
  }));

  /**
   * GET /share/card.png - the same thing, in the only format the big platforms take.
   *
   * This is what og:image points at. Facebook, X and LinkedIn accept PNG, JPEG, GIF and
   * WebP and nothing else; the SVG above is kept for the readers that prefer it.
   */
  router.get('/share/card.png', asyncRoute(async (req, res) => {
    const b = await balanceNow();
    res.type('image/png');
    res.set('Cache-Control', 'public, max-age=900, s-maxage=900');
    res.send(nationalCardPng(b));
  }));

  /**
   * GET /embed/station/:id - one gauge, as a page another site can iframe.
   *
   * Deliberately not the whole site in a frame: an embed has to be readable at 320px in
   * a column, so it carries one reading, its seasonal comparison, and a link home. The
   * link is the point - it is what makes an embed worth serving rather than giving away.
   */
  router.get('/embed/station/:id', asyncRoute(async (req, res) => {
    const station = getStation(req.params.id);
    if (!station) return res.status(404).type('html').send(embedShell('Ismeretlen szelvény', ''));

    const readings = await store.latestReadings(config.maxReadingAgeMs);
    const reading = readings[station.id];
    const flow = reading && Number.isFinite(reading.flowM3s) ? reading.flowM3s : null;
    const median = monthlyMedian(station.id, new Date().getUTCMonth());
    const ratio = flow !== null && median > 0 ? flow / median : null;

    res.type('html');
    res.set('Cache-Control', 'public, max-age=900, s-maxage=900');
    // Framing is the entire purpose, so the usual deny header must not be sent here.
    res.set('X-Frame-Options', 'ALLOWALL');
    res.send(stationEmbed(station, flow, median, ratio, reading));
  }));

  return router;
};

const MONTHS = ['januári', 'februári', 'márciusi', 'áprilisi', 'májusi', 'júniusi',
  'júliusi', 'augusztusi', 'szeptemberi', 'októberi', 'novemberi', 'decemberi'];

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const hu = (v, digits = 0) =>
  Number(v).toLocaleString('hu-HU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Band colours, matched to the site so a card and the page agree at a glance. */
function bandColour(ratio) {
  if (ratio === null) return '#41707d';
  if (ratio < 0.4) return '#a3341f';
  if (ratio < 0.6) return '#cf6a2e';
  if (ratio < 0.85) return '#a6791f';
  if (ratio < 1.3) return '#2f7fb5';
  return '#2b4f9e';
}

function nationalCard(b) {
  const inflow = b.inflow.totalM3s;
  const outflow = b.outflow.totalM3s;
  const ratio = b.inflow.ratioToSeasonal ?? b.inflow.ratioToMean ?? null;
  const seasonal = b.inflow.ratioToSeasonal != null;
  const month = MONTHS[new Date().getUTCMonth()];
  const colour = bandColour(ratio);
  const pct = ratio === null ? '–' : `${hu(ratio * 100)}%`;

  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f7fdff"/><stop offset="1" stop-color="#e6f4f8"/>
  </linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="10" fill="${colour}"/>

  <text x="64" y="104" font-size="27" fill="#41707d" letter-spacing="3">HOVAFOLYIK.HU</text>
  <text x="64" y="176" font-size="44" fill="#0a2c37">Ennyi víz lép be ma a határon</text>

  <!-- tspan, not two <text> at computed x. Guessing a string's rendered width from its
       character count collides the moment a number gains a digit or the font differs by
       a hair, and it did: "1445" ran into "m³/s". Letting SVG flow them inline removes
       the estimate entirely. -->
  <text x="64" y="330" fill="#0a2c37"><tspan font-size="150" font-weight="700">${esc(hu(inflow))}</tspan><tspan font-size="46" fill="#7b9aa4" dx="16">m³/s</tspan></text>

  <text x="64" y="404"><tspan font-size="40" fill="${colour}" font-weight="600">${esc(pct)}</tspan><tspan font-size="34" fill="#41707d" dx="14">${
    seasonal ? `az ilyenkor szokásosnak (${esc(month)} medián)` : 'az éves átlagnak'
  }</tspan></text>

  <text x="64" y="486" font-size="31" fill="#41707d">Távozik ${esc(hu(outflow))} m³/s</text>
  <text x="64" y="534" font-size="31" fill="#41707d">${b.inflow.stationCount} határszelvény élő mérése</text>

  <text x="64" y="592" font-size="24" fill="#7b9aa4">Forrás: OVF vízrajzi nyílt adatok · frissítve ${
    esc(new Date(b.timestamp).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short' }))
  }</text>
</svg>
`;
}

/* --- the raster card ------------------------------------------------------ */

/** The same palette as the SVG, as RGB triples for the rectangle renderer. */
const RGB = {
  bgTop: [247, 253, 255],
  bgBottom: [226, 244, 248],
  ink: [10, 44, 55],
  soft: [65, 112, 125],
  faint: [123, 154, 164],
  rule: [200, 226, 234],
};

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

function nationalCardPng(b) {
  const inflow = b.inflow.totalM3s;
  const outflow = b.outflow.totalM3s;
  const ratio = b.inflow.ratioToSeasonal ?? b.inflow.ratioToMean ?? null;
  const seasonal = b.inflow.ratioToSeasonal != null;
  const month = MONTHS[new Date().getUTCMonth()];
  const colour = hexToRgb(bandColour(ratio));

  const M = 64;                 // margin
  const CONTENT = W - M * 2;    // every line is given this and may not exceed it

  const bmp = new Bitmap(W, H, RGB.bgTop);
  bmp.verticalGradient(0, 0, W, H, RGB.bgTop, RGB.bgBottom);
  bmp.fill(0, 0, W, 12, colour);

  drawText(bmp, 'HOVAFOLYIK.HU', M, 58, 3, RGB.soft, { letterSpacing: 2, maxWidth: CONTENT });
  drawText(bmp, 'Ennyi víz lép be ma a határon', M, 106, 4, RGB.ink, { maxWidth: CONTENT });

  // The headline, in segments. Measured before drawing so the unit sits against it
  // rather than at a guessed offset - the SVG hit exactly this bug and fixed it with a
  // tspan, which is not available here.
  const value = hu(inflow);
  const digitsH = 156;
  const digitsW = numberWidth(value, digitsH);
  drawNumber(bmp, value, M, 196, digitsH, RGB.ink);
  drawText(bmp, 'm³/s', M + digitsW + 22, 292, 5, RGB.faint);

  // The comparison, which is the only part of this card that is an opinion about the
  // number rather than the number. On its own two lines: at the width this renderer
  // produces, the percentage and its explanation do not fit side by side, and the first
  // version of this card discovered that by running "(augusztusi mediá" off the edge.
  if (ratio !== null) {
    drawText(bmp, `${hu(ratio * 100)}%`, M, 400, 6, colour);
    drawText(bmp, seasonal ? `az ilyenkor szokásosnak (${month} medián)` : 'az éves átlagnak',
      M, 470, 3, RGB.soft, { maxWidth: CONTENT });
  } else {
    drawText(bmp, 'nincs összehasonlítási alap erre a hónapra', M, 430, 3, RGB.soft,
      { maxWidth: CONTENT });
  }

  bmp.fill(M, 516, CONTENT, 2, RGB.rule);

  drawText(bmp, `Távozik ${hu(outflow)} m³/s · ${b.inflow.stationCount} határszelvény élő mérése`,
    M, 536, 3, RGB.soft, { maxWidth: CONTENT });
  drawText(bmp, `Forrás: OVF · frissítve ${
    new Date(b.timestamp).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short' })
  }`, M, 578, 3, RGB.faint, { maxWidth: CONTENT });

  return bmp.toBuffer();
}

function embedShell(title, body) {
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — hovafolyik.hu</title>
<style>
  :root{--ink:#0a2c37;--ink-soft:#41707d;--ink-faint:#7b9aa4;--line:#cfe3ea;--flow:#1789a3}
  *{box-sizing:border-box}
  body{margin:0;padding:14px 16px;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       color:var(--ink);background:#fff}
  a{color:var(--flow)}
  .nm{font-weight:600;font-size:15px}
  .sub{font-size:12px;color:var(--ink-faint);margin-top:1px}
  .v{font-size:38px;font-weight:700;line-height:1.05;margin:10px 0 2px;
     font-variant-numeric:tabular-nums}
  .v span{font-size:15px;font-weight:400;color:var(--ink-faint);margin-left:5px}
  .cmp{font-size:13.5px;font-weight:600}
  .cmp small{display:block;font-weight:400;color:var(--ink-soft);margin-top:2px}
  .src{margin-top:12px;padding-top:9px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-faint)}
</style></head><body>${body}</body></html>
`;
}

function stationEmbed(station, flow, median, ratio, reading) {
  const colour = bandColour(ratio);
  const month = MONTHS[new Date().getUTCMonth()];
  const when = reading && reading.timestamp
    ? new Date(reading.timestamp).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', dateStyle: 'short', timeStyle: 'short' })
    : null;

  const body =
    `<div class="nm">${esc(station.name)}</div>` +
    `<div class="sub">${esc(station.river)}${station.riverKm ? ` · ${station.riverKm} fkm` : ''}</div>` +
    `<div class="v">${flow === null ? '–' : esc(hu(flow, 1))}<span>m³/s</span></div>` +
    (ratio !== null
      ? `<div class="cmp" style="color:${colour}">az ilyenkor szokásos ${esc(hu(ratio * 100))}%-a` +
        `<small>${esc(month)} medián ${esc(hu(median))} m³/s, tíz év alapján</small></div>`
      : `<div class="cmp" style="color:var(--ink-soft)">nincs tízéves összehasonlítás erre a hónapra</div>`) +
    `<div class="src">${when ? `Mérve ${esc(when)} · ` : ''}` +
    `Forrás: OVF · <a href="https://www.hovafolyik.hu/#szelveny=${encodeURIComponent(station.id)}" target="_blank" rel="noopener">hovafolyik.hu</a></div>`;

  return embedShell(station.name, body);
}

module.exports.nationalCard = nationalCard;
module.exports.stationEmbed = stationEmbed;
