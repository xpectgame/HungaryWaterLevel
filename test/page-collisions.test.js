'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).sort((a, b) => b.length - a.length)[0];

/**
 * The page is one file, one scope, and one namespace, and that keeps biting.
 *
 * Seven times now something has been declared twice in it. Six were CSS classes, where
 * the second rule quietly changed the first thing's appearance. The seventh was a
 * FUNCTION: a second `loadDrought` was added for the drought map, the later declaration
 * won, and the drought SECTION stopped rendering - while the map it had been written for
 * worked perfectly, so nothing looked broken. The section just went from 1358 pixels tall
 * to 183 and no error was raised anywhere.
 *
 * None of these are catchable by running the page. A duplicate declaration is legal
 * JavaScript and a duplicate class is legal CSS; both simply mean something other than
 * what was intended. So they are caught by reading the file instead.
 */

test('no top-level function is declared twice', () => {
  const names = [...script.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepStrictEqual(dupes, [],
    `declared twice - the later one silently replaces the earlier: ${dupes.join(', ')}`);
});

test('no top-level let/const binding is declared twice', () => {
  // A repeated `let` in the same scope is a SyntaxError and would be caught by loading
  // the page; a repeated `var` is not, and neither is a second `let` inside a block that
  // shadows an outer one by accident. This catches the flat, top-level case, which is
  // where this file keeps its state.
  const names = [];
  for (const m of script.matchAll(/^(?:let|const|var) ([^=;\n]+)[=;]/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[\s=]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepStrictEqual(dupes, [], `declared twice: ${dupes.join(', ')}`);
});

test('no CSS class rule is written twice with different declarations', () => {
  // Six of the seven collisions were this. A class defined once as a colour and again as
  // a layout put "MW" on its own line under every number on the power section, and the
  // only symptom was that the page looked slightly wrong.
  let css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  // Strip at-rule blocks first. A class redefined inside @media is the intended way to
  // change it on a narrow screen, not a collision - counting those made this test fail
  // on ten rules that were all correct, which is the kind of guard that gets deleted.
  for (let i = 0; i < 20; i += 1) {
    const stripped = css.replace(/@(?:media|supports|container)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    if (stripped === css) break;
    css = stripped;
  }
  // Single-class selectors only. Compound and descendant selectors legitimately repeat.
  const bodies = new Map();
  for (const m of css.matchAll(/(^|\n)\s*\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const [, , name, body] = m;
    const list = bodies.get(name) || [];
    list.push(body.trim().replace(/\s+/g, ' '));
    bodies.set(name, list);
  }
  const clashing = [...bodies]
    .filter(([, list]) => list.length > 1 && new Set(list).size > 1)
    .map(([name, list]) => `${name} (${list.length}x)`);
  assert.deepStrictEqual(clashing, [], `defined more than once: ${clashing.join(', ')}`);
});

test('no CSS comment closes early and turns prose into a selector', () => {
  // The eighth collision, and a new kind. A long explanatory comment above the wastewater
  // colours had a stray `*/` two thirds of the way through it: the comment ended there,
  // the remaining five lines of English became CSS, and the parser - looking for the `{`
  // that would end a selector - swallowed the next real rule along with them. `.sw.s-ok`
  // simply stopped existing, and since it differs from the base colour by a shade nobody
  // could see it. Nothing errors; a rule is just gone.
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const stray = [];
  let inComment = false;
  for (let i = 0; i < css.length - 1; i += 1) {
    if (!inComment && css[i] === '/' && css[i + 1] === '*') { inComment = true; i += 1; continue; }
    if (inComment && css[i] === '*' && css[i + 1] === '/') { inComment = false; i += 1; continue; }
    if (!inComment && css[i] === '*' && css[i + 1] === '/') {
      stray.push(`line ${css.slice(0, i).split('\n').length}`);
      i += 1;
    }
  }
  assert.deepStrictEqual(stray, [], `*/ outside a comment - the rule after it is dead: ${stray.join(', ')}`);
  assert.equal(inComment, false, 'a CSS comment is left open at the end of the stylesheet');
});

test('every element the script reaches for by id exists in the markup', () => {
  // $('layer-gw') against a layer that has been removed returns null and the draw
  // silently does nothing - which is exactly how the drought layers behaved after they
  // were moved to their own map.
  const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepStrictEqual(missing, [], `$() reaches for ids that are not in the page: ${missing.join(', ')}`);
});

/**
 * A control must not be rebuilt while somebody is dragging it.
 *
 * The water-use sliders could be stepped but not dragged - exactly one notch per
 * gesture, whichever direction you pushed. The cause: the `input` handler called a
 * redraw that rewrote the whole panel with innerHTML, so one animation frame into the
 * drag the range input under the reader's finger was destroyed and replaced by an
 * identical new one. Pointer capture was left on a node that no longer existed, which
 * ended the drag; the focus() that followed put the caret on the replacement, which is
 * why the arrow keys still worked and made it look like a slider that only stepped.
 *
 * Measured, before and after, with a real pointer drag in Chromium: the value moved by 2
 * with the panel being rebuilt, and by 20 without it.
 *
 * The invariant is simple and static, so it is checked by reading the file: nothing that
 * rebuilds the CONTROLS may be reachable from an input handler. Only the derived output
 * gets to re-render, and it lives in its own container.
 */
test('the slider input handler does not rebuild the controls', () => {
  const start = script.indexOf('function renderWaterUse(');
  assert.ok(start > 0, 'renderWaterUse is gone - has the section been renamed?');

  // The handler runs from the `input` listener down to the end of that callback.
  const listener = script.indexOf("slider.addEventListener('input'", start);
  assert.ok(listener > 0, 'no input listener on the water-use slider');
  const body = script.slice(listener, script.indexOf('if(sel)', listener));

  assert.ok(!/renderWaterUse\s*\(/.test(body),
    'the input handler calls renderWaterUse, which rewrites the sliders mid-drag');
  assert.ok(/wuOutputsDirty\s*\(/.test(body),
    'the input handler should refresh only the derived output');
});

test('the controls and the derived output are written to different containers', () => {
  // If both went into the same element, any output refresh would take the sliders with
  // it and the bug returns without the guard above ever firing.
  assert.match(script, /box\.innerHTML\s*=\s*`<div class="wu-grid">/,
    'the controls should be written into #wu-body once');
  assert.match(script, /const out = \$\('wu-out'\)/,
    'the outputs should render into their own #wu-out container');
  const outputs = script.slice(script.indexOf('function renderWaterUseOutputs('));
  assert.ok(!/box\.innerHTML/.test(outputs.slice(0, outputs.indexOf('\n}\n'))),
    'the output renderer must not write to the controls container');
});
