'use strict';

/**
 * Reads an OpenAPI document into something short enough to act on.
 *
 * The VRAQuery document is ~90 KB of JSON. Printing it whole is useless and reading it
 * by hand is slow; what is actually needed is two things: which paths exist, and the
 * exact shape of the one request body that returns a time series. So this flattens the
 * document to one line per operation, and expands a named schema on demand.
 *
 * It is deliberately tolerant. A spec is upstream's artefact, and half-populated
 * `$ref`s, missing `components`, and cycles are all normal; none of them should throw
 * in a tool whose entire job is to tell you what is there.
 */

/** Follow a local `$ref`. Remote refs are not resolved - nothing here needs them. */
function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = spec;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return null;
    node = node[segment];
  }
  return node || null;
}

/** The schema a `$ref` points at, or the schema itself. */
function deref(spec, schema, seen = new Set()) {
  let current = schema;
  while (current && current.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = resolveRef(spec, current.$ref);
  }
  return current || null;
}

/** A schema's type as one short string: `string`, `Foo[]`, `#/…/Bar`. */
function typeName(schema) {
  if (!schema) return 'unknown';
  if (schema.$ref) return schema.$ref.split('/').pop();
  if (schema.type === 'array') return `${typeName(schema.items)}[]`;
  if (schema.enum) return `enum(${schema.enum.slice(0, 8).join('|')})`;
  if (schema.format) return `${schema.type}/${schema.format}`;
  return schema.type || (schema.properties ? 'object' : 'unknown');
}

/**
 * One line per operation: method, path, summary, and the parameters it takes.
 *
 * Path parameters are the part that matters most here - the portal's bundle showed
 * `Vra/InternetVmo/{n}/false` being assembled, and the spec is what says what the two
 * positional values actually mean.
 */
function summarizeOperations(spec, { filter = null } = {}) {
  const lines = [];
  const paths = (spec && spec.paths) || {};

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    if (filter && !filter.test(path)) continue;

    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

      const summary = (op && (op.summary || op.description) || '').split('\n')[0].trim();
      lines.push(`${method.toUpperCase().padEnd(5)} ${path}${summary ? `   - ${summary}` : ''}`);

      for (const raw of (op && op.parameters) || []) {
        const param = raw && raw.$ref ? deref(spec, raw) : raw;
        if (!param) continue;
        const required = param.required ? ' (required)' : '';
        lines.push(`        ${param.in}: ${param.name}: ${typeName(param.schema)}${required}`);
      }

      const body = op && op.requestBody;
      if (body) {
        const content = (body.$ref ? deref(spec, body) : body).content || {};
        for (const [mediaType, media] of Object.entries(content)) {
          lines.push(`        body[${mediaType}]: ${typeName(media && media.schema)}`);
        }
      }

      const okResponse = op && op.responses && (op.responses['200'] || op.responses.default);
      for (const [mediaType, media] of Object.entries((okResponse && okResponse.content) || {})) {
        lines.push(`        200[${mediaType}]: ${typeName(media && media.schema)}`);
      }
    }
  }

  return lines;
}

/**
 * Expand a named schema into indented property lines.
 *
 * Bounded by depth rather than by trust: these documents contain self-referential
 * types, and an unbounded walk over one does not terminate.
 */
function describeSchema(spec, name, { depth = 3 } = {}) {
  const schemas = (spec && spec.components && spec.components.schemas) || {};
  const root = schemas[name];
  if (!root) {
    const available = Object.keys(schemas).slice(0, 60);
    return [`(no schema named ${name}) known: ${available.join(', ') || 'none'}`];
  }

  const lines = [];

  const walk = (schema, indent, remaining, seen) => {
    const resolved = deref(spec, schema);
    if (!resolved) return;

    if (resolved.type === 'array') {
      walk(resolved.items, indent, remaining, seen);
      return;
    }

    const properties = resolved.properties || {};
    const required = new Set(resolved.required || []);

    for (const [property, rawChild] of Object.entries(properties)) {
      const child = deref(spec, rawChild);
      const marker = required.has(property) ? '*' : ' ';
      const note = rawChild && rawChild.description ? `  // ${rawChild.description.split('\n')[0]}` : '';
      lines.push(`${indent}${marker} ${property}: ${typeName(rawChild)}${note}`);

      // A cycle is a property of the type, not of this branch, so the guard has to be
      // per-branch - a shared set would silently truncate a second, legitimate use.
      const ref = rawChild && rawChild.$ref;
      if (remaining > 0 && child && !(ref && seen.has(ref))) {
        walk(rawChild, `${indent}    `, remaining - 1, ref ? new Set([...seen, ref]) : seen);
      }
    }
  };

  lines.push(`${name}:`);
  walk(root, '  ', depth, new Set());
  return lines;
}

module.exports = { summarizeOperations, describeSchema, resolveRef, deref, typeName };
