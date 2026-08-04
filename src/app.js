'use strict';

/**
 * Deployment entry point.
 *
 * A host's framework detection - Vercel's Express preset among them - scans for
 * conventional entry filenames and imports the first match, requiring a request handler
 * as the default export. It found this path and rejected the module three deployments
 * running, because what lived here exported factories instead.
 *
 * So both names a detector can land on now export a built app: this file and server.js
 * at the repository root, which simply re-exports it. The factories moved to
 * src/create-app.js, a name nothing scans for.
 *
 * Nothing here binds a port - the host owns the socket. `npm start` runs server.js
 * directly, which does listen.
 */

const { createApp, createContext } = require('./create-app');
const { bootstrap } = require('./lib/serverless-entry');

const { handler, value: ctx } = bootstrap(() => createContext());
const app = handler || createApp(ctx);

module.exports = app;

// Carried on the export so the standalone entry can reuse this exact instance rather
// than building a second context - and a second database pool - of its own.
// Null when construction failed; `app` is then the handler that reports why.
module.exports.context = ctx;
