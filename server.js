'use strict';

/**
 * Deployment entry point.
 *
 * Hosts that run a Node project as a single server - Vercel among them - load the file
 * named by `main` in package.json and expect its default export to be a request handler
 * or an http.Server. Anything else fails at boot with "Invalid export found in module",
 * which is what happens if they land on src/server.js: that module deliberately exports
 * named factories so the tests and the CLI can build their own instances.
 *
 * So this file is the one and only default export: one Express app that serves the
 * frontend, the API and the scheduled ingest endpoint. It never calls listen() - the
 * host owns the socket. `npm start` runs src/server.js instead, which does bind a port.
 *
 * A configuration error during construction is caught and served as a readable JSON
 * response rather than escaping as an opaque platform crash.
 */

const { createApp, createContext } = require('./src/server');
const { bootstrap } = require('./src/lib/serverless-entry');

const { handler, value: ctx } = bootstrap(() => createContext());

module.exports = handler || createApp(ctx);
