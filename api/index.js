'use strict';

/**
 * Serverless function entry - Vercel's `api/` convention.
 *
 * With the framework preset set to "Other", Vercel serves public/ as static assets and
 * turns each file under api/ into a function. The rewrite in vercel.json sends every
 * /api/* request here, and the Express app routes it from there - including /api/cron,
 * which is why the scheduler does not need a function of its own.
 *
 * This re-exports src/app.js rather than building its own context, so whichever entry
 * the host picks - this one, src/app.js, or server.js - there is one context and one
 * database pool.
 */

module.exports = require('../src/app');
