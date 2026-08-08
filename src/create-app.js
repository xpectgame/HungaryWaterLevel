'use strict';

/**
 * Application factories.
 *
 * Exports named factories and never a ready-made app, so tests can build isolated
 * instances with their own stores and configuration.
 *
 * The name matters. A host's framework detection scans for conventional entry-point
 * filenames - app.js, server.js, index.js - imports the first one it finds, and requires
 * a request handler as the default export. This module exports an object, so being
 * picked would fail the deployment at boot. `create-app` is not a name any detector
 * looks for; the files that are (src/app.js and server.js) each export a built app.
 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');

const { loadConfig, assertProviderSafe } = require('./config');
const { createStore } = require('./store');
const { withProviderFilter } = require('./store/provider-filter');
const { TtlCache } = require('./lib/cache');
const { createRouter } = require('./routes');
const { createCronHandler } = require('./jobs/cron-handler');

/**
 * Minimal page served when the full frontend asset did not make it into the bundle.
 *
 * Deliberately dependency-free and inline - no map library, no external stylesheet -
 * because the situation it exists for is precisely one where external files are not
 * reaching the browser. It reads the same /snapshot endpoint the real page does, so the
 * numbers on screen are the live ones either way.
 */
const FALLBACK_PAGE = `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magyarország vízmérlege</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;background:#0e1621;color:#e8f0f7;margin:0;padding:40px 20px}
 main{max-width:640px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8ba3ba;font-size:13px;margin-bottom:24px}
 .row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #26384b}
 .lbl{color:#8ba3ba}.val{font-variant-numeric:tabular-nums;font-weight:600}
 .net{font-size:28px;font-weight:700;text-align:center;padding:12px 0}
 .pm{color:#8ba3ba;font-size:15px;font-weight:400}
 .note{color:#8ba3ba;font-size:12px;margin-top:20px;line-height:1.5}
 .warn{background:#4a3410;border:1px solid #7a5518;color:#f0c675;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:20px}
 a{color:#4a9fe0}
</style></head><body><main>
<h1>Magyarország vízmérlege</h1>
<div class="sub" id="sub">Betöltés…</div>
<div class="warn">Az interaktív térkép nem érhető el ebben a build-ben. Az adatok élők.</div>
<div class="net"><span id="net">–</span> <span class="pm" id="unc"></span></div>
<div class="row"><span class="lbl">Beáramlás</span><span class="val" id="in">–</span></div>
<div class="row"><span class="lbl">Kiáramlás</span><span class="val" id="out">–</span></div>
<div class="row"><span class="lbl">Erőművi vízkivétel</span><span class="val" id="w">–</span></div>
<div class="row"><span class="lbl">Erőművi vízfogyasztás</span><span class="val" id="c">–</span></div>
<div class="note" id="note"></div>
<div class="note"><a href="/api/v1/snapshot">/api/v1/snapshot</a> · <a href="/api/v1/health">/api/v1/health</a> · <a href="/api/v1/meta/sources">módszertan</a></div>
</main><script>
const f=(v,d)=>v==null?'–':v.toLocaleString('hu-HU',{minimumFractionDigits:d,maximumFractionDigits:d});
fetch('/api/v1/snapshot').then(r=>r.json()).then(s=>{
  const b=s.balance,p=s.power;
  document.getElementById('sub').textContent='Frissítve: '+new Date(s.generatedAt).toLocaleString('hu-HU')+(s._meta.synthetic?' · szintetikus adat':'');
  document.getElementById('net').textContent=(b.net.m3s>0?'+':'')+f(b.net.m3s,0)+' m³/s';
  document.getElementById('unc').textContent='± '+f(b.net.uncertaintyM3s,0);
  document.getElementById('in').textContent=f(b.inflow.totalM3s,0)+' m³/s';
  document.getElementById('out').textContent=f(b.outflow.totalM3s,0)+' m³/s';
  document.getElementById('w').textContent=f(p.totals.withdrawalM3s,1)+' m³/s';
  document.getElementById('c').textContent=f(p.totals.consumptionM3s,2)+' m³/s';
  document.getElementById('note').textContent=b.net.significant?'':'A nettó különbség a mérési bizonytalanságon belül van — nem különböztethető meg nullától.';
}).catch(e=>{document.getElementById('sub').textContent='Az API nem érhető el: '+e.message;});
</script></body></html>`;

function createApp(ctx) {
  const app = express();
  const { config } = ctx;

  app.disable('x-powered-by');
  app.set('json spaces', 0);

  // Open data, read-only, no credentials - a permissive CORS header is the whole point.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.use('/api/v1', createRouter(ctx));

  // The scheduled ingest lives inside the app rather than in a separate serverless
  // function, so it is reachable no matter how the host decides to run this project -
  // as one Node server, or as individual functions. It authenticates itself; see
  // jobs/cron-handler.js. Vercel's scheduler issues a GET.
  const cron = createCronHandler(ctx);
  app.get('/api/cron', cron);
  app.post('/api/cron', cron);

  // Bundlers trace imports, not filesystem reads, so a deployment can arrive with the
  // frontend missing while every module is present. Resolve it once at startup and say
  // so, rather than discovering it as a 500 on the first page view.
  const publicDir = config.publicDir || path.join(__dirname, '..', 'public');
  const indexHtml = path.join(publicDir, 'index.html');
  const hasFrontend = config.serveFrontend && fs.existsSync(indexHtml);

  if (config.serveFrontend && !hasFrontend) {
    console.warn(`[api] frontend not found at ${indexHtml}; serving the built-in fallback page`);
  }

  if (hasFrontend) {
    app.use(express.static(publicDir));
  }

  app.get('/', (req, res) => {
    if (!config.serveFrontend) return res.redirect('/api/v1/health');
    if (hasFrontend) return res.sendFile(indexHtml);
    // The API is the product; a missing asset must not make the deployment look dead.
    return res.type('html').send(FALLBACK_PAGE);
  });

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not found',
      hint: 'See /api/v1/health, /api/v1/snapshot, /api/v1/balance, /api/v1/stations, /api/v1/powerplants, /api/v1/meta/sources',
    });
  });

  // Anything thrown in a route lands here. The message goes to the log, not to the
  // client, since it can contain upstream URLs and internal paths.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[api] unhandled error on', req.method, req.originalUrl, '-', err.message);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

/**
 * Build the app and its dependencies without binding a port.
 * Shared by the standalone server and the serverless entry point.
 */
function createContext(env = process.env) {
  const config = loadConfig(env);
  assertProviderSafe(config);

  // Reads are filtered by provider so a switch from fixture to live cannot keep
  // serving generated rows under a live label. Writes go to the store unchanged.
  const store = withProviderFilter(createStore(config), config.provider);
  const cache = new TtlCache(config.cacheTtlMs);

  return { config, store, cache };
}

module.exports = { createApp, createContext };
