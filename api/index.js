'use strict';

/**
 * Serverless entry point (Vercel).
 *
 * The context is built once at module load, which on a serverless platform means once
 * per cold start. Warm invocations reuse it, so the in-memory store keeps whatever it
 * fetched during the instance's lifetime and most requests are served without touching
 * the upstream at all.
 *
 * Freshness comes from the on-demand refresh middleware rather than a background timer,
 * because there is no process alive between requests to run one. See src/lib/refresh.js.
 *
 * What this deployment cannot do, by construction:
 *   - long history (the store dies with the instance), so /balance/history and
 *     /stations/:id/timeseries return only this instance's short window
 *   - method=lagged, which needs days of history and therefore degrades to instant
 * Both already report their own degradation in the response, so nothing here lies.
 */

const { createApp, createContext } = require('../src/server');

const ctx = createContext();

module.exports = createApp(ctx);
