'use strict';

const USER_AGENT = 'HungaryWaterLevel/0.1 (open data aggregator)';

class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * fetch with a timeout, one retry on transient failure, and errors that say what broke.
 *
 * Upstream here is a pair of public government services with no SLA. They time out,
 * they return HTML error pages with a 200, and they occasionally 502. The poller runs
 * unattended every 15 minutes, so a failure has to be legible from a log line alone.
 */
async function fetchText(url, { timeoutMs = 15000, headers = {}, retries = 1 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
        signal: controller.signal,
        redirect: 'follow',
      });

      const body = await response.text();

      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status} from ${url}`, {
          status: response.status,
          url,
          body: body.slice(0, 500),
        });
      }

      return { body, contentType: response.headers.get('content-type') || '', url: response.url };
    } catch (err) {
      lastError = err.name === 'AbortError' ? new HttpError(`Timeout after ${timeoutMs}ms: ${url}`, { url }) : err;
      // A 4xx will not fix itself on retry; anything else might.
      if (err instanceof HttpError && err.status && err.status < 500) break;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Fetch and parse JSON.
 *
 * Checks that the body actually looks like JSON before parsing, because a captive
 * portal or an upstream error page returning HTML with status 200 is a real failure
 * mode here and "Unexpected token < in JSON" is a useless thing to find in a log.
 */
async function fetchJson(url, opts = {}) {
  const { body, contentType } = await fetchText(url, opts);
  const trimmed = body.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new HttpError(
      `Expected JSON from ${url} but got ${contentType || 'unknown content-type'}: ${trimmed.slice(0, 120)}`,
      { url, body: trimmed.slice(0, 500) },
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new HttpError(`Malformed JSON from ${url}: ${err.message}`, { url, body: trimmed.slice(0, 500) });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchText, fetchJson, HttpError, USER_AGENT };
