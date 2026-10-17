'use strict';

/*
 * Errata Finder — search a paper, surface its corrections/errata/retractions.
 *
 * Checks run for every paper:
 *   1. Crossref `updated-by` on the paper's own record — the publisher-deposited
 *      list of notices (correction, erratum, retraction, …) that update it.
 *   2. Title sweep of Crossref — catches notices whose publisher never deposited
 *      a formal update link (reported as "possible", not verified).
 *   3. OpenAlex `is_retracted` — retraction status from the Retraction Watch data.
 */

const CONFIG = {
  // Real address gets you into Crossref's & OpenAlex's polite pools. Replace it.
  mailto: '64185677+DavinciDreams@users.noreply.github.com',
  crossref: 'https://api.crossref.org',
  openalex: 'https://api.openalex.org',
  maxEnrich: 12,          // max correction records to fetch titles for
  sweepRows: 25,          // candidates pulled for the title sweep
  sweepThreshold: 0.55,   // fraction of the original title's tokens that must match
  // Citation-flag scan: quoted phrases searched (title+abstract+fulltext where
  // indexed) across papers that CITE the target. Results are gated on the phrase
  // actually appearing in the citing paper's title or abstract.
  flagPhrases: ['sign error', 'mistake in', 'contains an error'],
  noticeTitleFilter: 'correction|erratum|corrigendum|retraction|expression of concern',
  maxFlagged: 6,
};

const el = {
  form: document.getElementById('search-form'),
  input: document.getElementById('search-input'),
  button: document.getElementById('search-button'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
};

let currentDoi = null; // guards hashchange-driven re-runs of the same lookup
let lookupSeq = 0;     // only the most recently started lookup may render

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function crUrl(path, params = {}) {
  return apiUrl(CONFIG.crossref, path, params);
}

function oaUrl(path, params = {}) {
  return apiUrl(CONFIG.openalex, path, params);
}

function apiUrl(base, path, params) {
  const u = new URL(base + path);
  params.mailto = CONFIG.mailto;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u;
}

async function getJson(url, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Accepts a bare DOI or any URL containing one. Trailing punctuation is dropped,
// but a trailing ")" is kept when it balances a "(" (some DOIs contain parens).
function normalizeDoi(input) {
  const m = String(input).match(/10\.\d{4,9}\/\S+/i);
  if (!m) return null;
  let doi = m[0];
  doi = doi.replace(/[.,;>]+$/, '');
  if (doi.endsWith(')')) {
    const rest = doi.slice(0, -1);
    if ((rest.match(/\(/g) || []).length <= (rest.match(/\)/g) || []).length) doi = rest;
  }
  return doi.toLowerCase();
}

function doiHref(doi) { return 'https://doi.org/' + encodeURIComponent(doi); }

function fmtDate(parts) {
  if (!parts || !parts[0]) return '';
  const [y, m, d] = parts[0];
  if (!y) return '';
  if (!m) return String(y);
  const date = new Date(Date.UTC(y, m - 1, d || 1));
  return date.toLocaleDateString('en-GB', {
    year: 'numeric', month: 'short',
    ...(d ? { day: 'numeric' } : {}), timeZone: 'UTC',
  });
}

function authorsShort(authorArr) {
  if (!Array.isArray(authorArr) || !authorArr.length) return '';
  const names = authorArr.slice(0, 3).map(a => {
    if (a.family) return a.name || [a.given?.[0], a.family].filter(Boolean).join(' ');
    return a.name || '';
  }).filter(Boolean);
  if (!names.length) return '';
  return names.join(', ') + (authorArr.length > 3 ? ' et al.' : '');
}

function tokens(s) {
  return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
}

// Fraction of the original title's tokens that appear in the candidate title.
// Correction titles are usually "Correction to: <original title>", possibly truncated.
function titleContainment(candidateTitle, originalTitle) {
  const want = tokens(originalTitle);
  if (!want.size) return 0;
  const have = tokens(candidateTitle);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.size;
}

const UPDATE_WORD_RE = /(correction|erratum|errata|corrigendum|retract|expression of concern)/i;
const UPDATE_LEAD_RE = /^(author|publisher|editor)?'?\s*-?\s*(correction|erratum|corrigendum|retraction|expression of concern)s?\s*(to|for|of|:|—|–|-|,)?\s*/i;

function stripUpdateLead(title) {
  return String(title).replace(UPDATE_LEAD_RE, '').trim();
}

const BADGE_RULES = [
  [/retract/i, 'Retraction', 'badge badge-danger'],
  [/expression of concern/i, 'Expression of concern', 'badge badge-danger'],
  [/corrigendum/i, 'Corrigendum', 'badge'],
  [/errat/i, 'Erratum', 'badge'],
  [/correct/i, 'Correction', 'badge'],
];

function badgeFor(...sources) {
  const text = sources.filter(Boolean).join(' ');
  for (const [re, label, cls] of BADGE_RULES) {
    if (re.test(text)) return { label, cls };
  }
  return { label: 'Update', cls: 'badge badge-muted' };
}

function titleOf(work) {
  return (work && Array.isArray(work.title) && work.title[0]) || '';
}

/* ---------------- crossref providers ---------------- */

async function crossrefWork(doi) {
  const d = await getJson(crUrl('/works/' + encodeURIComponent(doi)));
  return d.message;
}

async function searchPapers(query) {
  const d = await getJson(crUrl('/works', {
    'query.bibliographic': query, rows: 8,
    select: 'DOI,title,author,container-title,issued,type',
  }));
  return d.message.items.filter(it => titleOf(it));
}

// Fetch display data (title, journal) for the linked notices.
async function enrichLinked(linked) {
  const slice = linked.slice(0, CONFIG.maxEnrich);
  const results = await Promise.allSettled(slice.map(u =>
    // select= is rejected on the /works/<doi> route, so fetch the full record
    getJson(crUrl('/works/' + encodeURIComponent(u.DOI))).then(d => d.message)
  ));
  slice.forEach((u, i) => {
    if (results[i].status === 'fulfilled') {
      const w = results[i].value;
      u.title = titleOf(w) || u.title;
      u.journal = (w['container-title'] || [])[0] || '';
      if (!u.dateParts) u.dateParts = (w.issued && w.issued['date-parts']) || null;
    }
  });
  return linked;
}

// Notices whose publisher never deposited an update link: match by title.
async function titleSweep(doi, title, excludeDois) {
  if (!title) return [];
  const d = await getJson(crUrl('/works', {
    'query.title': title, rows: CONFIG.sweepRows,
    select: 'DOI,title,author,container-title,issued,type',
  }));
  const items = d.message.items || [];
  return items.filter(it => {
    if (it.DOI === doi || excludeDois.has(it.DOI.toLowerCase())) return false;
    const t = titleOf(it);
    if (!UPDATE_WORD_RE.test(t)) return false;
    return titleContainment(stripUpdateLead(t), title) >= CONFIG.sweepThreshold;
  });
}

/* ---------------- citation-flag scan ---------------- */

function abstractFromInverted(idx) {
  if (!idx) return '';
  const out = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) out[p] = word;
  }
  return out.join(' ');
}

// Sentence around the first occurrence of `phrase`, bounded to ~2 sentences.
function snippetAround(text, phrase, span = 130) {
  const t = String(text).replace(/\s+/g, ' ');
  const i = t.toLowerCase().indexOf(phrase.toLowerCase());
  if (i === -1) return '';
  let s = Math.max(0, i - span);
  let e = Math.min(t.length, i + phrase.length + span);
  const ls = t.lastIndexOf('. ', s);
  if (ls > 0) s = ls + 2;
  const le = t.indexOf('. ', e);
  if (le !== -1 && le - e < span) e = le + 1;
  return (s > 0 ? '… ' : '') + t.slice(s, e).trim() + (e < t.length ? ' …' : '');
}

function flagVenue(w) {
  return (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '';
}

function stripOaDoi(u) { return (u.doi || '').replace('https://doi.org/', ''); }

// Papers citing the target that use error language or carry notice-style titles.
// This is the channel that catches "shown wrong in a later paper" cases which
// never exist as formal errata (e.g. Moody–Wilczek 1984 ← Daido–Takahashi 2017).
async function citationFlagScan(doi, excludeDois) {
  const d = await getJson(oaUrl('/works', {
    filter: `doi:${doi}`, select: 'id,doi,is_retracted,display_name,cited_by_count',
  }));
  const w = (d.results || [])[0];
  const retracted = w && (w.is_retracted === true || /^retracted:/i.test(w.display_name || ''));
  if (!w || !w.cited_by_count) return { retracted, strong: [], weak: [], more: 0 };

  const wid = w.id.split('/').pop();

  const phraseJobs = CONFIG.flagPhrases.map(p =>
    getJson(oaUrl('/works', {
      filter: `cites:${wid}`, search: `"${p}"`, 'per-page': 10,
      select: 'id,doi,display_name,publication_year,primary_location,abstract_inverted_index',
    })).then(r => (r.results || []).map(x => ({ ...x, phrase: p })))
  );

  // Notice-titled citers are cross-checked in Crossref: an "Erratum: X" paper
  // inherits X's reference list, so it can cite our target while correcting a
  // different paper. Only keep it if it corrects the target or corrects nothing
  // specific (unlinked notice).
  const noticeChecks = async notices =>
    Promise.all(notices.slice(0, 5).map(async n => {
      // "Corrections to Newton's law" is physics content, not a notice: require
      // the title to lead with the notice word itself.
      if (!UPDATE_LEAD_RE.test(n.display_name || '')) return null;
      const ndoi = stripOaDoi(n).toLowerCase();
      let keep = true;
      let reason = 'notice-titled paper citing this one';
      if (ndoi) {
        try {
          const rec = await crossrefWork(ndoi);
          const target = (rec['update-to'] || [])[0];
          if (target && String(target.DOI).toLowerCase() !== doi) keep = false;
          if (target && keep) reason = 'publisher notice for this paper';
        } catch { /* record unavailable; keep default reason */ }
      }
      return keep ? {
        DOI: ndoi, title: n.display_name, venue: flagVenue(n),
        year: n.publication_year, reason, snippet: '',
      } : null;
    }));

  const [phraseSets, notices] = await Promise.all([
    Promise.allSettled(phraseJobs),
    getJson(oaUrl('/works', {
      filter: `cites:${wid},title.search:${CONFIG.noticeTitleFilter}`, 'per-page': 10,
      select: 'id,doi,display_name,publication_year,primary_location',
    })).then(r => r.results || []).catch(() => []),
  ]);

  const seen = new Set(notices.map(n => n.id));
  const weak = [];
  for (const set of phraseSets) {
    if (set.status !== 'fulfilled') continue;
    for (const r of set.value) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const rdoi = stripOaDoi(r).toLowerCase();
      if (!rdoi || rdoi === doi || excludeDois.has(rdoi)) continue;
      // Gate: the phrase must appear in title or abstract, not just full text.
      const abstract = abstractFromInverted(r.abstract_inverted_index);
      if (!abstract.toLowerCase().includes(r.phrase) &&
          !(r.display_name || '').toLowerCase().includes(r.phrase)) continue;
      weak.push({
        DOI: rdoi, title: r.display_name, venue: flagVenue(r),
        year: r.publication_year, reason: `mentions “${r.phrase}”`,
        snippet: snippetAround(abstract, r.phrase),
      });
    }
  }
  const strong = (await noticeChecks(notices)).filter(Boolean);
  return { retracted, strong, weak, more: Math.max(0, weak.length - CONFIG.maxFlagged) };
}

/* ---------------- rendering ---------------- */

function setStatus(html, { error = false, busy = false } = {}) {
  el.status.classList.toggle('is-error', error);
  el.status.innerHTML = html;
  el.form.classList.toggle('busy', busy);
  el.button.disabled = busy;
  if (busy) el.input.setAttribute('aria-disabled', 'true');
  else el.input.removeAttribute('aria-disabled');
}

const spinner = () => '<span class="spinner" aria-hidden="true"></span>';

function renderCandidates(items, query) {
  const cards = items.map(it => {
    const meta = [
      authorsShort(it.author),
      (it['container-title'] || [])[0],
      fmtDate(it.issued && it.issued['date-parts']),
      it.type,
    ].filter(Boolean).join(' · ');
    return `<button type="button" class="candidate" data-doi="${esc(it.DOI)}">
      <h3>${esc(titleOf(it))}</h3>
      <p class="meta">${esc(meta)}</p>
      <p class="doi-line"><code>${esc(it.DOI)}</code></p>
    </button>`;
  }).join('');
  el.results.innerHTML =
    `<p class="candidates-title">Papers matching “${esc(query)}” — pick yours</p>
     <div class="candidate-list">${cards}</div>`;
  el.results.querySelectorAll('.candidate').forEach(btn =>
    btn.addEventListener('click', () => runLookup(btn.dataset.doi)));
}

function renderUpdateCard(u, verified) {
  const { label, cls } = badgeFor(u.type, u.label, u.title);
  const title = u.title || u.label || 'Publisher notice';
  const meta = [u.journal, u.dateParts ? fmtDate(u.dateParts) : ''].filter(Boolean).join(' · ');
  const url = doiHref(u.DOI);
  return `<article class="update-card">
    <div class="update-head">
      <span class="${cls}">${esc(label)}</span>
      ${verified ? '' : '<span class="badge badge-muted">unverified match</span>'}
      <span class="update-date">${esc(u.dateParts ? fmtDate(u.dateParts) : '')}</span>
    </div>
    <h3><a href="${esc(url)}" rel="noopener" target="_blank">${esc(title)}</a></h3>
    <p class="update-meta">${esc(meta)}${meta ? ' · ' : ''}<code>${esc(u.DOI)}</code></p>
  </article>`;
}

function renderFlagCard(f) {
  const isNotice = /^notice|publisher/.test(f.reason);
  const { label, cls } = isNotice
    ? badgeFor(f.title)
    : { label: 'citing paper', cls: 'badge badge-muted' };
  const meta = [f.venue, f.year].filter(Boolean).join(' · ');
  const heading = f.DOI
    ? `<a href="${esc(doiHref(f.DOI))}" rel="noopener" target="_blank">${esc(f.title || f.DOI)}</a>`
    : esc(f.title || 'Untitled record');
  return `<article class="update-card">
    <div class="update-head">
      <span class="${cls}">${esc(label)}</span>
      <span class="update-date">${esc(f.reason)}</span>
    </div>
    <h3>${heading}</h3>
    <p class="update-meta">${esc(meta)}${meta && f.DOI ? ' · ' : ''}${f.DOI ? `<code>${esc(f.DOI)}</code>` : ''}</p>
    ${f.snippet ? `<blockquote class="snippet">${esc(f.snippet)}</blockquote>` : ''}
  </article>`;
}

function renderAnalysis({ work, doi, linked, possible, flags, retracted, updatesOf, sources }) {
  const title = titleOf(work) || '(untitled record)';
  const meta = [
    authorsShort(work.author),
    (work['container-title'] || [])[0],
    fmtDate(work.issued && work.issued['date-parts']),
    work.type,
  ].filter(Boolean).join(' · ');

  let html = `
    <article class="paper-card">
      <h2><a href="${esc(doiHref(doi))}" rel="noopener" target="_blank">${esc(title)}</a></h2>
      <p class="meta">${esc(meta)}</p>
      <p class="doi-line"><code>${esc(doi)}</code></p>
    </article>`;

  if (updatesOf) {
    html += `
      <div class="banner banner-info"><span aria-hidden="true">ℹ</span>
        <span><strong>This record is itself a correction.</strong>
        It updates: <a href="${esc(doiHref(updatesOf.DOI))}" rel="noopener" target="_blank">${esc(updatesOf.title || updatesOf.DOI)}</a>
        (${esc(updatesOf.label || updatesOf.type || 'update')}).</span>
      </div>`;
  }

  if (retracted) {
    const rwQuery = encodeURIComponent(title);
    html += `
      <div class="banner banner-danger"><span aria-hidden="true">⚠</span>
        <span><strong>Retracted.</strong> OpenAlex flags this paper as retracted
        (Retraction Watch data).
        <a href="https://retractionwatch.com/?s=${rwQuery}" rel="noopener" target="_blank">Find the Retraction Watch entry →</a></span>
      </div>`;
  }

  if (linked.length) {
    html += `
      <h2 class="section-title">Corrections &amp; errata for this paper (${linked.length})</h2>
      <p class="section-note">Formally linked to this paper in Crossref, as deposited by the publisher.</p>
      <div class="update-list">${linked.map(u => renderUpdateCard(u, true)).join('')}</div>`;
  }

  if (possible.length) {
    html += `
      <h2 class="section-title">Possible corrections not formally linked (${possible.length})</h2>
      <p class="section-note">Matched by title only — the publisher deposited no update link, so verify these are really about this paper before relying on them.</p>
      <div class="update-list">${possible.map(u => renderUpdateCard({
        ...u, dateParts: u.issued && u.issued['date-parts'],
        journal: (u['container-title'] || [])[0],
      }, false)).join('')}</div>`;
  }

  const shownDois = new Set(
    [...linked, ...possible].map(u => String(u.DOI || '').toLowerCase())
  );
  const strong = (flags.strong || []).filter(f => !f.DOI || !shownDois.has(f.DOI));
  const weak = (flags.weak || []).filter(f => !f.DOI || !shownDois.has(f.DOI));
  const more = (flags.more || 0) + Math.max(0, (flags.weak || []).length - weak.length);

  if (strong.length || weak.length) {
    const total = strong.length + weak.length;
    const cards = [
      ...strong.map(renderFlagCard),
      ...weak.slice(0, CONFIG.maxFlagged).map(renderFlagCard),
    ].join('');
    html += `
      <h2 class="section-title">Flagged by papers citing this one (${total}${more ? '+' : ''})</h2>
      <p class="section-note">Heuristic scan: these papers cite this work and use error language, or carry a notice-style title. Matched via OpenAlex full-text search — read the flagged passage to judge whether it really concerns this paper.</p>
      <div class="update-list">${cards}</div>
      ${more ? `<p class="section-note">+ ${more} more match${more === 1 ? '' : 'es'} not shown</p>` : ''}`;
  }

  if (!linked.length && !possible.length && !strong.length && !weak.length) {
    const rwQuery = encodeURIComponent(title);
    const gsQuery = encodeURIComponent(`"${title}" correction OR erratum`);
    html += `
      <div class="all-clear">
        <h2>No corrections found for this paper.</h2>
        <p>Checked: Crossref’s publisher-deposited update links, a title sweep of Crossref,
        and OpenAlex’s retraction flag and citation scan for error language${retracted ? ' (retraction was flagged — see above)' : ''}.</p>
        <p class="caveat">Coverage is not complete: publishers don’t always deposit errata, and some
        correction notices are titled too generically to match. For high-stakes decisions also check
        the Crossmark button on the publisher’s page and the sources below.</p>
        <div class="manual-links">
          <a class="chip" href="https://retractionwatch.com/?s=${rwQuery}" rel="noopener" target="_blank">Search Retraction Watch</a>
          <a class="chip" href="https://scholar.google.com/scholar?q=${gsQuery}" rel="noopener" target="_blank">Search Google Scholar</a>
          <a class="chip" href="${esc(doiHref(doi))}" rel="noopener" target="_blank">Open publisher page</a>
        </div>
      </div>`;
  }

  const srcHtml = sources.map(s =>
    `<span class="${s.ok ? 'ok' : 'fail'}">${esc(s.name)}${s.ok ? '' : ' unavailable'}</span>`
  ).join('');
  html += `<div class="sources">Checked just now: ${srcHtml}</div>`;

  el.results.innerHTML = html;
}

/* ---------------- pipeline ---------------- */

async function runTitleSearch(query) {
  const seq = ++lookupSeq;
  currentDoi = null;
  history.replaceState(null, '', location.pathname);
  setStatus(`${spinner()} Searching Crossref for matching papers…`, { busy: true });
  el.results.innerHTML = '';
  try {
    const items = await searchPapers(query);
    if (seq !== lookupSeq) return;
    if (!items.length) {
      setStatus(`No papers matched “${esc(query)}”. Try adding an author surname, or paste the DOI (10.xxxx/…).`, { error: true });
      return;
    }
    if (items.length === 1) {
      await runLookup(items[0].DOI);
      return;
    }
    setStatus(`Found ${items.length} matching papers — pick yours below.`);
    renderCandidates(items, query);
  } catch (err) {
    showFetchError(err);
  }
}

async function runLookup(doi) {
  if (currentDoi === doi) { el.results.scrollIntoView({ behavior: 'smooth' }); return; }
  const seq = ++lookupSeq;
  currentDoi = doi;
  location.hash = '/doi/' + encodeURIComponent(doi);
  el.results.innerHTML = '';
  setStatus(`${spinner()} Fetching the paper’s Crossref record…`, { busy: true });

  let work;
  try {
    work = await crossrefWork(doi);
  } catch (err) {
    if (seq !== lookupSeq) return;
    if (err.status === 404) {
      setStatus(`Crossref has no record for DOI <code>${esc(doi)}</code>. It may be a typo, or registered with another agency — try <a href="${esc(doiHref(doi))}" rel="noopener" target="_blank">resolving it directly</a>.`, { error: true });
    } else {
      showFetchError(err);
    }
    return;
  }

  const title = titleOf(work);
  setStatus(`${spinner()} Checking for updates, unlinked corrections and retraction status…`, { busy: true });

  const linked = (work['updated-by'] || []).map(u => ({
    DOI: u.DOI,
    type: u.type,
    label: u.label,
    dateParts: u.updated && u.updated['date-parts'],
  }));
  const excludeDois = new Set([doi, ...linked.map(u => String(u.DOI || '').toLowerCase())]);

  // If this record is itself a notice, resolve what it corrects for the banner.
  const updatesTo = (work['update-to'] || [])[0] || null;
  const resolveTarget = updatesTo
    ? crossrefWork(updatesTo.DOI).catch(() => null)
    : Promise.resolve(null);

  const jobs = await Promise.allSettled([
    linked.length ? enrichLinked(linked) : Promise.resolve(linked),
    titleSweep(doi, title, excludeDois),
    citationFlagScan(doi, excludeDois),
    resolveTarget,
  ]);

  const [linkedRes, sweepRes, flagRes, targetRes] = jobs;
  if (seq !== lookupSeq) return;
  const possible = sweepRes.status === 'fulfilled' ? sweepRes.value : [];
  const flags = flagRes.status === 'fulfilled' ? flagRes.value
    : { retracted: null, strong: [], weak: [], more: 0 };

  let updatesOf = null;
  if (updatesTo) {
    const target = targetRes.status === 'fulfilled' ? targetRes.value : null;
    updatesOf = {
      DOI: updatesTo.DOI,
      label: updatesTo.label || updatesTo.type,
      title: target ? titleOf(target) : '',
    };
  }

  renderAnalysis({
    work, doi,
    linked: linkedRes.status === 'fulfilled' ? linkedRes.value : linked,
    possible,
    flags,
    retracted: flags.retracted,
    updatesOf,
    sources: [
      { name: 'Crossref update links', ok: linkedRes.status === 'fulfilled' },
      { name: 'Crossref title sweep', ok: sweepRes.status === 'fulfilled' },
      { name: 'OpenAlex retraction + citation scan', ok: flagRes.status === 'fulfilled' },
    ],
  });

  const n = (linkedRes.status === 'fulfilled' ? linkedRes.value.length : linked.length);
  const nFlags = flags.strong.length + flags.weak.length;
  if (n || possible.length || nFlags) {
    const parts = [];
    if (n + possible.length) parts.push(`${n + possible.length} update${n + possible.length === 1 ? '' : 's'}`);
    if (nFlags) parts.push(`${nFlags} citation flag${nFlags === 1 ? '' : 's'}`);
    if (possible.length) parts.push(`(${possible.length} unverified match${possible.length === 1 ? '' : 'es'})`);
    setStatus(`Found ${parts.join(', ')}.`);
  } else {
    setStatus('Search complete.');
  }
}

function showFetchError(err) {
  const rate = err && (err.status === 429 || err.name === 'AbortError');
  setStatus(rate
    ? 'A data source was rate-limited or timed out — wait a few seconds and try again.'
    : 'Could not reach the data sources. Check your connection and try again.', { error: true });
}

/* ---------------- wiring ---------------- */

function submitQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return;
  el.input.value = q;
  const doi = normalizeDoi(q);
  if (doi) runLookup(doi);
  else runTitleSearch(q);
}

el.form.addEventListener('submit', e => {
  e.preventDefault();
  submitQuery(el.input.value);
});

el.input.addEventListener('input', () => { currentDoi = null; });

document.querySelectorAll('.chip[data-q]').forEach(chip =>
  chip.addEventListener('click', () => submitQuery(chip.dataset.q)));

function handleHash() {
  const m = location.hash.match(/^#\/doi\/(.+)$/);
  if (m) {
    const doi = decodeURIComponent(m[1]);
    if (doi) {
      el.input.value = doi;
      runLookup(doi);
    }
  }
}

window.addEventListener('hashchange', handleHash);
handleHash();
