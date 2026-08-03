'use strict';

const { loadConfig } = require('../config');
const { createProvider, fetchAll } = require('../sources');
const { validateBatch } = require('../lib/validate');
const { computeBalance } = require('../domain/balance');
const { loadLagHistory } = require('../lib/lag-history');
// The store is required lazily inside the CLI block: importing it here would pull in
// node:sqlite (and its experimental warning) even for serverless runs that never
// touch a database.

/**
 * The 15-minute ingest cycle: fetch both upstreams, screen the readings, store them,
 * then compute and store a balance snapshot.
 *
 * Snapshots are persisted rather than computed on demand because they are the historical
 * record - recomputing later would give a different answer once late-arriving gauge
 * corrections land, and a chart that silently rewrites its own past is worse than one
 * that is slightly stale.
 */

async function runOnce(store, config, logger = console) {
  const startedAt = Date.now();
  const provider = createProvider(config);
  const result = await fetchAll(provider);

  const summary = {
    provider: provider.name,
    synthetic: provider.synthetic,
    stationsStored: 0,
    stationsRejected: 0,
    generationStored: false,
    balanceStored: false,
    errors: result.errors,
  };

  if (result.hydrology && result.hydrology.readings) {
    const { accepted, rejected } = validateBatch(result.hydrology.readings);
    summary.stationsStored = await store.putStationReadings(accepted);
    summary.stationsRejected = rejected.length;
    if (rejected.length > 0) {
      summary.rejected = rejected;
      logger.warn(`[poll] rejected ${rejected.length} implausible reading(s):`, rejected);
    }
  }

  if (result.generation) {
    summary.generationStored = await store.putGeneration(result.generation);
  }

  // The balance is computed from what is now in the store rather than from the fetch
  // result, so a station that failed this cycle but succeeded recently still counts.
  const readings = await store.latestReadings(config.maxReadingAgeMs);
  if (Object.keys(readings).length > 0) {
    const balance = computeBalance(readings, {
      method: config.defaultBalanceMethod,
      historyLookup:
        config.defaultBalanceMethod === 'lagged' ? await loadLagHistory(store) : undefined,
    });
    summary.balanceStored = await store.putBalance(balance);
    summary.netM3s = balance.net.m3s;
    summary.significant = balance.net.significant;
  }

  summary.durationMs = Date.now() - startedAt;
  await store.logPoll(result.errors.length === 0, summary);

  logger.log(
    `[poll] ${provider.name}: ${summary.stationsStored} readings, ` +
      `net ${summary.netM3s ?? 'n/a'} m3/s, ${summary.errors.length} upstream error(s), ${summary.durationMs}ms`,
  );

  return summary;
}

/** Start the recurring poll. Returns a stop function. */
function startPolling(store, config, logger = console) {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) {
      logger.warn('[poll] previous cycle still running, skipping this tick');
      return;
    }
    running = true;
    try {
      await runOnce(store, config, logger);
    } catch (err) {
      // A poll failure must never take the server down - the API keeps serving the
      // last good snapshot and reports its age.
      logger.error('[poll] cycle failed:', err.message);
      await store.logPoll(false, { error: err.message });
    } finally {
      running = false;
    }
  };

  if (config.pollOnStart) {
    setImmediate(tick);
  }
  timer = setInterval(tick, config.pollIntervalMs);
  if (timer.unref) timer.unref();

  // Daily housekeeping so the database does not grow without bound.
  const pruneTimer = setInterval(async () => {
    try {
      const removed = await store.prune(config.retentionDays);
      if (removed > 0) logger.log(`[poll] pruned ${removed} row(s) older than ${config.retentionDays} days`);
    } catch (err) {
      logger.error('[poll] prune failed:', err.message);
    }
  }, 24 * 3600 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  return () => {
    clearInterval(timer);
    clearInterval(pruneTimer);
  };
}

/**
 * Fill the store with synthetic history.
 *
 * Not cosmetic: the travel-time-corrected balance cannot work until history reaches
 * back past the longest travel time in the registry (~200 h on the upper Tisza), and
 * charts need something to draw. Fixture-only, since the past cannot be fabricated for
 * a live deployment.
 */
async function backfill(store, config, days = 30, logger = console) {
  if (config.provider !== 'fixture') {
    throw new Error('Backfill only works with DATA_PROVIDER=fixture - real history must come from the upstream archive.');
  }

  const fixture = require('../sources/fixture');
  const stepMs = config.pollIntervalMs;
  const end = Date.now();
  const start = end - days * 86400000;
  let stored = 0;

  for (let t = start; t <= end; t += stepMs) {
    const at = new Date(t);
    const hydrology = await fixture.fetchAll(process.env, at);
    stored += await store.putStationReadings(hydrology.readings);

    const generation = await fixture.fetchGeneration(process.env, at);
    await store.putGeneration(generation);

    const balance = computeBalance(hydrology.readings, { method: 'instant', now: t });
    await store.putBalance(balance);
  }

  logger.log(`[backfill] wrote ${stored} synthetic readings across ${days} days`);
  return stored;
}

if (require.main === module) {
  const { createStore } = require('../store');
  const config = loadConfig();
  const store = createStore(config);
  const args = process.argv.slice(2);

  const main = async () => {
    if (args.includes('--backfill')) {
      const daysArg = args.find((a) => a.startsWith('--days='));
      const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
      await backfill(store, config, days);
    } else {
      await runOnce(store, config);
    }
  };

  main()
    .then(async () => {
      await store.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[poll] failed:', err);
      await store.close();
      process.exit(1);
    });
}

module.exports = { runOnce, startPolling, backfill };
