'use strict';

/**
 * Boots a serverless entry point without letting a configuration mistake become an
 * opaque platform error.
 *
 * Building the context at module scope is the right thing on serverless - it happens
 * once per cold start and is reused by every warm invocation. But anything it throws
 * escapes before a handler exists, so the platform reports only
 * FUNCTION_INVOCATION_FAILED. The actual cause - a missing env var, a malformed
 * connection string - is buried in a log the operator has to go find.
 *
 * So the throw is caught here and turned into a handler that answers every request
 * with the real reason. The function still fails, loudly and with the correct status,
 * but it explains itself.
 */
function bootstrap(build) {
  try {
    return { handler: null, error: null, value: build() };
  } catch (error) {
    return { handler: configErrorHandler(error), error, value: null };
  }
}

function configErrorHandler(error) {
  // Logged once per cold start so it also reaches the platform's log view.
  console.error('[boot] configuration error:', error.message);

  return (req, res) => {
    res.status(500).json({
      error: 'Configuration error - the function could not start',
      detail: error.message,
      hint: 'Check this deployment\'s environment variables, then redeploy. Vercel does not apply variable changes to an existing deployment.',
    });
  };
}

module.exports = { bootstrap };
