'use strict';

const express = require('express');
const { buildEvents } = require('../domain/events');
const { buildAlerts } = require('../domain/alerts');
const { pollableStations } = require('../config/stations');
const { LAKES } = require('../config/lakes');
const { asyncRoute } = require('../lib/async-route');
const { withMeta } = require('./balance');

/**
 * Alerts, as JSON and as Atom.
 *
 * Atom rather than a mailing list, and deliberately so. A newsroom already has something
 * that watches feeds; it does not want another account, and this project does not want a
 * table of other people's email addresses, a double opt-in flow, unsubscribe tokens and
 * a GDPR surface in order to say "the Tisza is at a ten-year low". A feed is the whole
 * feature with none of that, and anyone who does want mail can point any of a dozen
 * existing services at the feed.
 *
 * Atom, not RSS 2.0: entries need a stable id that is separate from their link, and Atom
 * has one. That is exactly the property the whole alert design rests on.
 */

const WINDOW_DAYS = 10;
const SITE = 'https://www.hovafolyik.hu';

/**
 * Assemble the alert document. One function, used by both representations - two paths
 * building the same feed drift apart, and the one nobody looks at is the one that drifts.
 */
async function collect(ctx, minSeverity) {
  const { store, config } = ctx;
  const to = Date.now();
  const from = to - WINDOW_DAYS * 24 * 3600 * 1000;
  const stations = pollableStations();

  const [readings, generationSeries, ...series] = await Promise.all([
    store.latestReadings(config.maxReadingAgeMs),
    store.generationSeries(from, to, 2000),
    ...stations.map((s) => store.stationSeries(s.id, from, to, 2000)),
    ...LAKES.map((l) => store.stationSeries(l.id, from, to, 2000)),
  ]);

  const historyByStation = {};
  stations.forEach((s, i) => { historyByStation[s.id] = series[i]; });
  const lakeHistory = {};
  LAKES.forEach((l, i) => { lakeHistory[l.id] = series[stations.length + i]; });

  const built = buildEvents({ readings, historyByStation, lakeHistory, generationSeries });
  return buildAlerts(built, readings, { minSeverity });
}

/** `undefined` when absent, `null` when present but not 1, 2 or 3. */
function parseSeverity(raw) {
  if (raw === undefined) return 2;
  const n = Number(raw);
  return [1, 2, 3].includes(n) ? n : null;
}

module.exports = function alertRoutes(ctx) {
  const router = express.Router();

  /** GET /alerts?minSeverity=1|2|3 */
  router.get('/alerts', asyncRoute(async (req, res) => {
    const minSeverity = parseSeverity(req.query.minSeverity);
    if (minSeverity === null) {
      return res.status(400).json({ error: `minSeverity must be 1, 2 or 3 (got '${req.query.minSeverity}')` });
    }
    return res.json(await withMeta(await collect(ctx, minSeverity), ctx));
  }));

  return router;
};

/**
 * The Atom feed. Mounted at the site root rather than under /api, because a feed is a
 * thing a reader subscribes to, not an API call, and /feed.xml is where they look.
 */
module.exports.feedRoute = function feedRoute(ctx) {
  const router = express.Router();

  router.get('/feed.xml', asyncRoute(async (req, res) => {
    const minSeverity = parseSeverity(req.query.minSeverity);
    if (minSeverity === null) {
      // A feed reader cannot show a JSON error, and a 400 it retries forever is worse
      // than the default. Bad parameter, sensible feed.
      return res.redirect(302, '/feed.xml');
    }
    res.type('application/atom+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(toAtom(await collect(ctx, minSeverity)));
  }));

  return router;
};

function toAtom(doc) {
  const entries = (doc.alerts || []).map((a) => {
    // tag: URIs, not the site URL with a query string: an alert has no page of its own,
    // and an id that looks like a link invites a reader to follow it to a 404. The date
    // in the tag is the scheme's, fixed - it is not the alert's date.
    const id = `tag:hovafolyik.hu,2026:alert/${a.id}`;
    const link = a.stationId ? `${SITE}/#szelveny=${encodeURIComponent(a.stationId)}` : SITE;
    return [
      '  <entry>',
      `    <title>${xml(a.title)}</title>`,
      `    <id>${xml(id)}</id>`,
      `    <link rel="alternate" href="${xml(link)}"/>`,
      `    <published>${xml(a.at)}</published>`,
      `    <updated>${xml(a.updated)}</updated>`,
      `    <category term="${xml(a.kind)}"/>`,
      `    <category term="${xml(a.level)}"/>`,
      `    <summary type="text">${xml(a.detail || '')}</summary>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="hu">',
    '  <title>hovafolyik.hu — riasztások</title>',
    '  <subtitle>Magyarország felszíni vízmérlege: rekordalacsony vízhozamok, árvízi fokozatok, tartós kisvíz.</subtitle>',
    `  <id>tag:hovafolyik.hu,2026:alerts</id>`,
    `  <link rel="alternate" href="${SITE}/"/>`,
    `  <link rel="self" href="${SITE}/feed.xml"/>`,
    `  <updated>${xml(doc.generatedAt)}</updated>`,
    '  <author><name>hovafolyik.hu</name></author>',
    `  <rights>Forrás: Országos Vízügyi Főigazgatóság vízrajzi nyílt adatok, MAVIR, ENTSO-E.</rights>`,
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

/**
 * Escape for XML text and attributes.
 *
 * Station names carry an en dash and Hungarian accents, which are fine as UTF-8, but the
 * five predefined entities are not optional: one ampersand in a title turns the whole
 * document into a parse error, and a feed reader shows nothing at all rather than one
 * broken entry.
 */
function xml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports.toAtom = toAtom;
