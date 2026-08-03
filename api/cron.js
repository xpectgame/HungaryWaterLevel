'use strict';

/**
 * Cron target: runs one ingest cycle and writes it to shared storage.
 *
 * This is what makes a serverless deployment well-behaved. Without it, every cold
 * instance fetches the upstream itself, so load on data.vizugy.hu scales with visitors -
 * roughly 30 requests per cold start against a free public service. With it, the upstream
 * sees exactly one cycle per schedule tick no matter how many people are watching, and
 * every request is served from the database.
 *
 * Vercel authenticates cron invocations with `Authorization: Bearer $CRON_SECRET`.
 * The logic lives in src/jobs/cron-handler.js so it is testable.
 */

const { createContext } = require('../src/server');
const { createCronHandler } = require('../src/jobs/cron-handler');
const { bootstrap } = require('../src/lib/serverless-entry');

const { handler, value: ctx } = bootstrap(() => createContext());

module.exports = handler || createCronHandler(ctx);
