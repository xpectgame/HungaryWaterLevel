'use strict';

/**
 * Minimal dotted-path extraction, enough to make response mapping configurable
 * without pulling in a JSONPath dependency.
 *
 *   extract(obj, 'data.items.0.value')
 *   extract(obj, 'value')
 */
function extract(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path).split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor == null) return undefined;
    cursor = Array.isArray(cursor) && /^\d+$/.test(part) ? cursor[Number(part)] : cursor[part];
  }
  return cursor;
}

/**
 * Depth-first search for the first non-empty array in a payload.
 *
 * The fallback for when a service wraps its rows in a envelope key we did not
 * anticipate - far more useful than failing outright while the exact shape of an
 * upstream response is still being pinned down.
 */
function firstArray(obj, maxDepth = 4) {
  if (Array.isArray(obj)) return obj.length > 0 ? obj : null;
  if (obj == null || typeof obj !== 'object' || maxDepth <= 0) return null;
  for (const value of Object.values(obj)) {
    const found = firstArray(value, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

/** Collect every dotted path in a payload - used by the probe tool to show real shapes. */
function describeShape(obj, prefix = '', out = [], maxDepth = 5) {
  if (maxDepth <= 0) return out;
  if (Array.isArray(obj)) {
    out.push(`${prefix || '$'}[] (${obj.length} items)`);
    if (obj.length > 0) describeShape(obj[0], `${prefix}.0`, out, maxDepth - 1);
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') {
        describeShape(value, path, out, maxDepth - 1);
      } else {
        out.push(`${path} = ${JSON.stringify(value)}`);
      }
    }
  }
  return out;
}

module.exports = { extract, firstArray, describeShape };
