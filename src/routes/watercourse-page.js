'use strict';

const express = require('express');
const { buildWatercourse, searchWatercourses, slugify } = require('../domain/watercourse');
const { asyncRoute } = require('../lib/async-route');

/**
 * /viz/:slug - a page per watercourse, rendered on the server.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECTION OF THE FRONT PAGE
 * ---------------------------------------------------------------------------
 * Everything else on this site lives on one page, deliberately. This does not, and the
 * reason is the only reason that would justify the exception: a link to the Rákos-patak
 * has to say "Rákos-patak" when it is pasted into a group chat. The front page cannot do
 * that - it has one title and one card for all 15 065 streams - and a client-rendered
 * route cannot either, because the crawler that builds the preview does not run the
 * JavaScript that would fill it in.
 *
 * So it is a real URL with its own <title> and its own og:title, and the front page
 * links into it. This is the difference between a feature people use and a feature people
 * send to each other.
 *
 * ---------------------------------------------------------------------------
 * NO JAVASCRIPT, AND NO SECOND STYLESHEET
 * ---------------------------------------------------------------------------
 * The page is complete when it arrives. Everything on it is known at request time from
 * three baked registers, so there is nothing to fetch, nothing to hydrate, and it renders
 * on a phone with a dead connection to a cached copy. The styles are inline and small
 * rather than a copy of the front page's 200 KB of CSS - a page this simple does not need
 * the map's design system, and keeping a second copy of it in sync would be a standing
 * source of drift.
 */

const SITE = 'https://www.hovafolyik.hu';

module.exports = function watercoursePageRoutes() {
  const router = express.Router();

  router.get('/viz', asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const results = q.length >= 2 ? searchWatercourses(q, { limit: 40 }) : [];
    res.type('html');
    res.set('Cache-Control', 'public, max-age=600, s-maxage=3600');
    res.send(searchPage(q, results));
  }));

  router.get('/viz/:slug', asyncRoute(async (req, res) => {
    const w = buildWatercourse(req.params.slug);
    if (!w) {
      const guesses = searchWatercourses(String(req.params.slug).replace(/-/g, ' '), { limit: 12 });
      res.status(404).type('html');
      return res.send(notFoundPage(req.params.slug, guesses));
    }
    res.type('html');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.send(waterPage(w));
  }));

  return router;
};

/* --- rendering ------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root{--ink:#0f2b38;--muted:#4d6b78;--line:#cfe0e7;--bg:#f4f9fb;--card:#fff;--accent:#0b6e8f;--warm:#b4541e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:24px 18px 64px}
a{color:var(--accent)}
header.top{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
header.top a.home{font-weight:700;text-decoration:none}
h1{font-size:clamp(28px,6vw,40px);margin:.2em 0 .1em;line-height:1.15}
.sub{color:var(--muted);margin:0 0 26px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 18px}
.card h2{font-size:18px;margin:0 0 10px}
.facts{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 22px;padding:0;list-style:none}
.facts li{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:14px}
.facts b{font-variant-numeric:tabular-nums}
.chain{list-style:none;margin:0;padding:0}
.chain li{position:relative;padding:0 0 14px 26px;border-left:2px solid var(--line);margin-left:8px}
.chain li:last-child{border-left-color:transparent;padding-bottom:0}
.chain li::before{content:"";position:absolute;left:-7px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--accent)}
.chain li.gauged::before{background:var(--warm)}
.chain .step{font-weight:600}
.chain .why{color:var(--muted);font-size:14px}
.stop{color:var(--muted);font-size:14px;border-left:2px dashed var(--line);margin-left:8px;padding:2px 0 0 26px}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.03em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:12px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pills{display:flex;flex-wrap:wrap;gap:7px;padding:0;margin:0;list-style:none}
.pills a{display:inline-block;padding:4px 11px;border:1px solid var(--line);border-radius:999px;background:var(--card);text-decoration:none;font-size:14px}
.empty{color:var(--muted);margin:0}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
form.find{display:flex;gap:8px;margin:0 0 20px}
form.find input{flex:1 1 auto;min-width:0;padding:10px 13px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--card);color:inherit}
form.find button{padding:10px 16px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;font:inherit;cursor:pointer}
@media (prefers-color-scheme:dark){
  :root{--ink:#e6f1f5;--muted:#93b0bc;--line:#274854;--bg:#0d1f28;--card:#132b36;--accent:#5fc0e0;--warm:#e08b52}
  form.find button{color:#08181f}
}
`;

function shell({ title, description, canonical, body, ogTitle }) {
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="hovafolyik.hu">
<meta property="og:locale" content="hu_HU">
<meta property="og:title" content="${esc(ogTitle || title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle || title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>💧</text></svg>">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="home" href="/">💧 hovafolyik.hu</a> <span class="tag">vízfolyás-adatlap</span></header>
${body}
</div>
</body>
</html>`;
}

/** The sentence that becomes the link preview. */
function summarise(w) {
  const bits = [];
  const chain = w.downstream.steps.map((s) => s.name);
  if (chain.length) bits.push(`Ide folyik: ${chain.join(' → ')}.`);
  else if (!w.trunk) bits.push('A vízrajzi jegyzék nem adja meg, hova folyik.');
  if (w.trunk) bits.push(`${w.tributaries.count} vízfolyás folyik bele a jegyzék szerint.`);
  else if (w.lengthKmMax) bits.push(`${fmt(w.lengthKmMax)} folyamkilométer.`);
  const d = w.discharges;
  if (d.sewageCount || d.industryCount) {
    bits.push(`${d.sewageCount} szennyvíztelep és ${d.industryCount} ipari bevezetés van rajta nyilvántartva.`);
  }
  return bits.join(' ') || `${w.name} — vízfolyás-adatlap.`;
}

function waterPage(w) {
  const canonical = `${SITE}/viz/${w.slug}`;
  const description = summarise(w);
  const parts = [];

  parts.push(`<h1>${esc(w.name)}</h1>`);
  parts.push(`<p class="sub">${w.trunk
    ? 'Főfolyó. A kisvízfolyás-jegyzék hivatkozik rá, de saját szakaszként nem tartalmazza — ezért a hossz és a befogadó itt üres.'
    : 'Vízfolyás a magyar vízrajzi jegyzékből.'}</p>`);

  /* the facts strip */
  const facts = [];
  if (!w.trunk) {
    if (w.lengthKmMax) facts.push(`<li>Hossz (fkm): <b>${fmt(w.lengthKmMax)}</b></li>`);
    facts.push(`<li>Szakaszok: <b>${w.segments}</b></li>`);
  }
  facts.push(`<li>Mellékvizek: <b>${w.tributaries.count}</b></li>`);
  facts.push(`<li>Szennyvíztelep: <b>${w.discharges.sewageCount}</b></li>`);
  facts.push(`<li>Ipari bevezetés: <b>${w.discharges.industryCount}</b></li>`);
  parts.push(`<ul class="facts">${facts.join('')}</ul>`);

  /* where it goes - the reason the site is called what it is called */
  parts.push('<section class="card"><h2>Hova folyik?</h2>');
  if (w.trunk) {
    parts.push('<p class="empty">Ez maga a befogadó — a kisebb vízfolyások ide érkeznek.</p>');
    if (w.gauges && w.gauges.length) {
      parts.push(`<p>Ezen a folyón ${w.gauges.length} szelvényt mérünk: ${w.gauges
        .map((g) => `<b>${esc(g.name)}</b>${g.riverKm ? ` (${fmt(g.riverKm)} fkm)` : ''}`)
        .join(', ')}. <a href="/#s-vizallas">Mai értékek →</a></p>`);
    }
  } else if (w.downstream.steps.length) {
    parts.push('<ol class="chain">');
    for (const s of w.downstream.steps) {
      const link = s.slug ? `<a href="/viz/${esc(s.slug)}">${esc(s.name)}</a>` : esc(s.name);
      const why = s.gauged
        ? `mérjük — ${s.gauges.map((g) => esc(g.name)).join(', ')}`
        : (s.trunk ? 'főfolyó' : '');
      parts.push(`<li class="${s.gauged ? 'gauged' : ''}"><span class="step">${link}</span>`
        + (why ? ` <span class="why">· ${why}</span>` : '')
        + (s.alsoInto && s.alsoInto.length
          ? ` <span class="why">· egyes szakaszok szerint: ${s.alsoInto.map(esc).join(', ')}</span>` : '')
        + '</li>');
    }
    parts.push('</ol>');
    parts.push(`<p class="stop">${esc(chainNote(w.downstream))}</p>`);
  } else {
    parts.push('<p class="empty">A vízrajzi jegyzék ennél a névnél nem adja meg a befogadót. '
      + 'Ez nem azt jelenti, hogy nem folyik sehova — azt jelenti, hogy a nyilvántartás nem mondja meg. '
      + 'A hiányzó láncszemet nem találjuk ki.</p>');
  }
  parts.push('</section>');

  /* what is discharged into it */
  const d = w.discharges;
  parts.push('<section class="card"><h2>Mi kerül bele?</h2>');
  if (!d.sewageCount && !d.industryCount) {
    parts.push('<p class="empty">A két nyilvántartásban nincs erre a vízfolyásra bejegyzett bevezetés. '
      + 'A szennyvízregiszter 732 telepéből csak 133 nevezi meg a befogadót, tehát ez inkább '
      + 'a nyilvántartás hiánya, mint bizonyíték a tisztaságra.</p>');
  }
  if (d.sewageCount) {
    parts.push('<h3 style="font-size:15px;margin:14px 0 6px">Szennyvíztisztító telepek</h3>');
    parts.push('<table><tr><th>Telep</th><th>Kapacitás (LE)</th><th>m³/év</th><th></th></tr>');
    for (const p of d.sewage.slice(0, 25)) {
      parts.push(`<tr><td>${esc(p.name)}</td><td class="num">${p.capacityPe ? fmt(p.capacityPe) : '—'}</td>`
        + `<td class="num">${p.m3Year ? fmt(p.m3Year) : '—'}</td>`
        + `<td>${matchTag(p.match)}</td></tr>`);
    }
    parts.push('</table>');
  }
  if (d.industryCount) {
    parts.push('<h3 style="font-size:15px;margin:16px 0 6px">Ipari bevezetések</h3>');
    parts.push('<table><tr><th>Ágazat</th><th>Nyilvántartott befogadó</th><th></th></tr>');
    for (const p of d.industry.slice(0, 25)) {
      parts.push(`<tr><td>${esc(p.sector || '—')}</td><td>${esc(p.receivingWater)}</td>`
        + `<td>${matchTag(p.match)}</td></tr>`);
    }
    parts.push('</table>');
    parts.push('<p class="empty" style="font-size:14px;margin-top:10px">Az ipari nyilvántartás '
      + 'egyetlen soron sem közöl mennyiséget, terhelést vagy üzemeltetőt, és az első vízgyűjtő-'
      + 'gazdálkodási terv (kb. 2009) állapotát tükrözi.</p>');
  }
  parts.push('</section>');

  /* what flows into it */
  if (w.tributaries.count) {
    parts.push(`<section class="card"><h2>Mi folyik bele? (${w.tributaries.count})</h2>`);
    if (w.tributaries.waters.length) {
      parts.push('<ul class="pills">');
      for (const t of w.tributaries.waters) {
        parts.push(`<li><a href="/viz/${esc(t.slug)}">${esc(t.name)}</a></li>`);
      }
      parts.push('</ul>');
    }
    const more = w.tributaries.named - w.tributaries.waters.length;
    const extras = [];
    if (more > 0) extras.push(`…és további ${more} nevesített vízfolyás`);
    // Counted, not listed: a third of the register is nameless ditches, and six
    // "Névtelen-1025" links beside four real names bury the useful half.
    if (w.tributaries.unnamed) extras.push(`${w.tributaries.unnamed} névtelen vízfolyás vagy árok`);
    if (extras.length) parts.push(`<p class="empty" style="margin-top:10px">${esc(extras.join(', '))}.</p>`);
    parts.push('</section>');
  }

  if (w.sameSlug && w.sameSlug.length) {
    parts.push(`<section class="card"><h2>Hasonló nevek</h2><p class="empty">A jegyzékben ugyanezzel a rövid névvel szerepel még: ${w.sameSlug.map(esc).join(', ')}.</p></section>`);
  }

  parts.push(`<form class="find" action="/viz" method="get">
    <input name="q" placeholder="Másik vízfolyás neve…" aria-label="Vízfolyás keresése">
    <button type="submit">Keresés</button></form>`);

  parts.push(`<footer>Forrás: ${esc(w.source || 'geoportal.vizugy.hu')} · jegyzék: ${esc(w.vintage || '—')}.
    A hosszadat a jegyzék folyamkilométer-adata, nem lemért csatornahossz.
    <a href="/#s-modszertan">Módszertan</a> · <a href="/api/v1/viz/${esc(w.slug)}">Ez az oldal JSON-ben</a></footer>`);

  return shell({
    title: `${w.name} — hova folyik? | hovafolyik.hu`,
    ogTitle: `${w.name}: ${w.downstream.steps.length ? `→ ${w.downstream.steps.map((s) => s.name).join(' → ')}` : 'vízfolyás-adatlap'}`,
    description,
    canonical,
    body: parts.join('\n'),
  });
}

function chainNote(chain) {
  if (chain.endsWith === 'gauged') return 'Innentől mért folyó — a napi vízhozam az oldal Vízállás szekciójában.';
  if (chain.endsWith === 'trunk') return 'A lánc főfolyónál ér véget: a kisvízfolyás-jegyzék eddig követi.';
  if (chain.endsWith === 'loop') return 'A nyilvántartásban a szakaszok kölcsönösen egymást jelölik meg befogadóként — itt megállunk.';
  if (chain.endsWith === 'truncated') return 'A lánc hosszabb, mint amit itt kirajzolunk.';
  return 'A jegyzék innentől nem adja meg a következő befogadót.';
}

function matchTag(match) {
  if (match === 'exact') return '<span class="tag">pontos név</span>';
  if (match === 'normalised') return '<span class="tag">névegyeztetés</span>';
  return '<span class="tag">víztest neve alapján</span>';
}

function searchPage(q, results) {
  const parts = [];
  parts.push('<h1>Melyik vízfolyás?</h1>');
  parts.push('<p class="sub">15 065 név a magyar vízrajzi jegyzékből. Írd be a patakod nevét.</p>');
  parts.push(`<form class="find" action="/viz" method="get">
    <input name="q" value="${esc(q)}" placeholder="Például: Rákos-patak" aria-label="Vízfolyás keresése" autofocus>
    <button type="submit">Keresés</button></form>`);
  if (q.length >= 2 && !results.length) {
    parts.push(`<p class="empty">Nincs találat erre: <b>${esc(q)}</b>.</p>`);
  }
  if (results.length) {
    parts.push('<section class="card"><table><tr><th>Név</th><th>Befogadó</th><th>fkm</th></tr>');
    for (const r of results) {
      parts.push(`<tr><td><a href="/viz/${esc(r.slug)}">${esc(r.name)}</a></td>`
        + `<td>${r.into ? esc(r.into) : '<span class="empty">—</span>'}</td>`
        + `<td class="num">${r.lengthKmMax ? fmt(r.lengthKmMax) : '—'}</td></tr>`);
    }
    parts.push('</table></section>');
  }
  parts.push('<footer>Forrás: geoportal.vizugy.hu vízrajzi alaptérkép. <a href="/">Vissza a főoldalra</a></footer>');
  return shell({
    title: q ? `${q} — vízfolyás keresés | hovafolyik.hu` : 'Vízfolyás keresés | hovafolyik.hu',
    description: 'Keresd meg a saját patakodat: hova folyik, mi kerül bele, mi folyik bele.',
    canonical: `${SITE}/viz`,
    body: parts.join('\n'),
  });
}

function notFoundPage(slug, guesses) {
  const parts = [];
  parts.push('<h1>Nincs ilyen nevű vízfolyás</h1>');
  parts.push(`<p class="sub">A jegyzékben nem szerepel ez: <b>${esc(slug)}</b>.</p>`);
  if (guesses.length) {
    parts.push('<section class="card"><h2>Erre gondoltál?</h2><ul class="pills">');
    for (const g of guesses) parts.push(`<li><a href="/viz/${esc(g.slug)}">${esc(g.name)}</a></li>`);
    parts.push('</ul></section>');
  }
  parts.push(`<form class="find" action="/viz" method="get">
    <input name="q" value="${esc(String(slug).replace(/-/g, ' '))}" aria-label="Vízfolyás keresése">
    <button type="submit">Keresés</button></form>`);
  parts.push('<footer><a href="/">Vissza a főoldalra</a></footer>');
  return shell({
    title: 'Nincs ilyen vízfolyás | hovafolyik.hu',
    description: 'A keresett vízfolyás nem szerepel a jegyzékben.',
    canonical: `${SITE}/viz`,
    body: parts.join('\n'),
  });
}

function fmt(v) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('hu-HU', { maximumFractionDigits: v < 100 ? 1 : 0 });
}

module.exports.slugify = slugify;
