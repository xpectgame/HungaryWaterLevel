'use strict';

const { fetchText } = require('../lib/http');

/**
 * Fetches and flattens documentation pages.
 *
 * The hydrological query service publishes its own contract - request syntax, parameter
 * names, response format - as plain help pages. Reading them is strictly better than
 * probing paths blind, and the only reason it has not happened yet is that they were
 * unreachable from the machine this was written on. A CI runner can reach them, so it
 * fetches them and prints them into the job log.
 */

const MAX_CHARS_PER_DOC = 6000;

/** Crude HTML to text - enough to read a help page out of a job log. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Keep link targets: on an API help page the URL is usually the point.
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 [$1]')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchDocs(urls) {
  console.log('\n########## documentation ##########');

  for (const url of urls) {
    console.log(`\n----- ${url} -----`);
    try {
      const { body, contentType } = await fetchText(url, { timeoutMs: 20000, retries: 0 });
      const text = htmlToText(body);

      if (text.length === 0) {
        console.log(`(empty, content-type ${contentType})`);
        continue;
      }

      console.log(text.slice(0, MAX_CHARS_PER_DOC));
      if (text.length > MAX_CHARS_PER_DOC) {
        console.log(`\n... truncated, ${text.length - MAX_CHARS_PER_DOC} more characters`);
      }
    } catch (err) {
      console.log(`FAILED: ${err.message.split('\n')[0]}`);
    }
  }
}

module.exports = { fetchDocs, htmlToText };
