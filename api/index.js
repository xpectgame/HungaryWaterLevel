'use strict';

/**
 * Serverless entry point (Vercel).
 *
 * The context is built once at module load, which on a serverless platform means once
 * per cold start. Warm invocations reuse it, so the in-memory or pooled connection
 * survives between requests.
 *
 * If that build throws - a missing environment variable, a malformed connection string -
 * the failure is caught and served as a readable JSON error rather than escaping as an
 * opaque FUNCTION_INVOCATION_FAILED. See src/lib/serverless-entry.js.
 *
 * Freshness comes from the cron in vercel.json when shared storage is configured, or
 * from the on-demand refresh middleware when it is not.
 */

const { createApp, createContext } = require('../src/server');
const { bootstrap } = require('../src/lib/serverless-entry');

const { handler, value: ctx } = bootstrap(() => createContext());

module.exports = handler || createApp(ctx);
