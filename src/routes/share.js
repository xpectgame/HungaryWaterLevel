'use strict';

const express = require('express');
const { computeBalance } = require('../domain/balance');
const { monthlyMedian } = require('../domain/flow-history');
const { getStation } = require('../config/stations');
const { asyncRoute } = require('../lib/async-route');

/**
 * The two things that decide whether this project spreads: what a pasted link looks
 * like, and whether a newsroom can put a piece of it inside their own article.
 *
 * SVG, not PNG. A social card is normally rendered with a headless browser or an image
 * library; this project has zero dependencies and adding a rasteriser for one image
 * would be the largest thing in it. Facebook and LinkedIn will not render SVG in a
 * preview - that is a real limitation, stated in the methodology rather than papered
 * over - but Slack, Mastodon, Discord and every RSS reader will, and those are where a
 * link to this actually travels between journalists.
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
