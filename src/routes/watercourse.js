'use strict';

const express = require('express');
const {
  buildWatercourse, searchWatercourses, loadWatercourses,
} = require('../domain/watercourse');
const { asyncRoute } = require('../lib/async-route');

/**
 * /api/v1/viz - one watercourse, and where its water goes.
 *
 * Two endpoints because they answer two different questions and have very different
 * costs: the search walks 15 065 names on every call, the lookup is a map hit. Splitting
 * them means a page that knows the slug never pays for the search.
 *
 * Both are cacheable for a long time and say so. Nothing under here changes between
 * bakes: the drainage register is a yearly-ish publication, and the two discharge
 * registers are older than that. This is the one part of the API where a stale answer is
 * not merely acceptable but correct.
 */
module.exports = function watercourseRoutes() {
  const router = express.Router();

  /** GET /api/v1/viz?q= - name search, for the box on the front page. */
  router.get('/viz', asyncRoute(async (req, res) => {
    const doc = loadWatercourses();
    if (!doc) {
      return res.status(503).json({
        available: false,
        reason: 'A vízfolyás-jegyzék nincs betöltve.',
      });
    }

    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (q.length < 2) {
      return res.json({
        available: true,
        query: q,
        results: [],
        count: doc.count,
        hint: 'Legalább két karakter kell a kereséshez.',
      });
    }

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.json({
      available: true,
      query: q,
      results: searchWatercourses(q, { limit }),
      count: doc.count,
      source: doc.source,
    });
  }));

  /** GET /api/v1/viz/:slug - the whole picture for one watercourse. */
  router.get('/viz/:slug', asyncRoute(async (req, res) => {
    const body = buildWatercourse(req.params.slug);
    if (!body) {
      // The suggestions matter more than the status code here. A reader who typed a
      // stream name that the register spells differently - Gaja for Gaja-patak - gets
      // the answer in the 404 rather than a dead end.
      const guesses = searchWatercourses(String(req.params.slug).replace(/-/g, ' '), { limit: 8 });
      return res.status(404).json({
        available: false,
        slug: req.params.slug,
        reason: 'Nincs ilyen nevű vízfolyás a jegyzékben.',
        suggestions: guesses,
      });
    }

    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.json(body);
  }));

  return router;
};
