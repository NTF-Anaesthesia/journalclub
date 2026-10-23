// Library pages: search and browse (sort, filter chips, select mode), add by DOI or PubMed ID, bulk PDF import,
// paper page (notes, PDF, star, lists). Saved and list pages: src/saved.js; bulk actions: src/bulk.js.
import {
  doc, getDoc, getDocs, collection, setDoc, addDoc, deleteDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp,
} from 'firebase/firestore';
import { searchPapers, mergeHits } from './search.js';
import { findDoi, atotwDoi } from './doi.js';
import { abstractSections, cleanPaper } from './abstract.js';
import { editSheet, releaseHand } from './edit.js';
import { refreshId } from './refresh.js';
import { loadLibrary as loadCatalogue, current, dirty as markDirty, forget, readHead, writeHead, readSync, timing, withTimeout, headCatalogue } from './catalogue.js';
import { SORTS, sortLabel, discussedAt, CHIPS, emptyFilter, filterOn, matches, chipCounts, tagCounts, sortEntries, selectAll, SELECT_CAP } from './filters.js';
import { loadStarred, setStarred, loadRecent, touchRecent, loadLists } from './prefs.js';
import { sheet, snack, addToSheet, starSelected, refreshSelected, fillSelected, reindexSelected, removeSelected, moreSheet, jobSheet, job, onJob, indexedIds, markIndexed, renderDuplicates } from './bulk.js';
import { renderSaved, renderList } from './saved.js';
import { isOffline, forget as forgetOffline, syncStarred } from './offline.js';

export const LIBRARY_ROUTES = ['library', 'add', 'import', 'paper', 'remove', 'lists', 'list', 'reindex', 'duplicates', 'read'];
const NUS_PROXY = 'https://libproxy1.nus.edu.sg/login?url=';

let c;              // { db, user, member, view, el, esc } for the current render
const PAGE = 50;
const HEAD_SORT = new Set(['discussed', 'newest']); // the saved first paint is the top 50 of the default order
// The list's state, kept while moving between pages: search, filters, sort, rows shown, and a selection to restore.
const SORT_KEY = 'jc.sort';
const savedSort = () => { try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(([k]) => k === v) ? v : 'discussed'; } catch { return 'discussed'; } };
const ui = { q: '', filter: emptyFilter(), sort: savedSort(), shown: PAGE, pendingSel: null };
const ABSTRACT_NOTE = {
  pdf: 'Taken from the PDF’s own abstract or summary.',
};
const AUTHORS_KEY = 'jc.showAuthors';
const showAuthors = () => { try { return localStorage.getItem(AUTHORS_KEY) === '1'; } catch { return false; } };

const $in = (root, sel) => root.querySelector(sel);
const mayEdit = (p) => c.member.role === 'admin' || p.addedBy === c.user.uid;
const authorLine = (a = []) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '));
const tagList = (s) => [...new Set(String(s).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
const loadLibrary = () => loadCatalogue(c.db);
const dirty = markDirty;
export { dirty };
const STAR = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';
const ICON = {
  add: '<path d="M4 12l8-8h6v6l-8 8z"/><circle cx="15" cy="9" r="1.2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};

async function apiFetch(path, init = {}) {
  const token = await c.user.getIdToken();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}

// PDF text and notes are searched by the Worker. Errors (offline, search not set up) leave metadata hits only.
async function serverSearch(q) {
  try {
    const r = await apiFetch('/api/search?q=' + encodeURIComponent(q));
    return r.ok ? { hits: (await r.json()).hits || [] } : { hits: [], down: r.status === 503 };
  } catch { return { hits: [] }; }
}
const snippetHtml = (s) => c.esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');

export function renderLibraryRoute(r, ctx) {
  c = ctx;
  if (r.name === 'add') return renderAdd();
  if (r.name === 'import') return renderImport();
  if (r.name === 'read' && r.arg) return import('./reader.js').then((m) => m.renderReader(r, c, apiFetch));
  if (r.name === 'paper' && r.arg) return renderPaper(r.arg, Number(r.arg2) || null);
  if (r.name === 'remove' && r.arg) return renderRemove(r.arg);
  if (r.name === 'lists') return renderSaved(c, loadLibrary, paperItem);
  if (r.name === 'list' && r.arg) return renderList(c, r.arg, loadLibrary, paperItem);
  if (r.name === 'reindex') return renderReindex();
  if (r.name === 'duplicates') return renderDuplicates(c, loadLibrary);
  return renderSearch();
}

const presentedOn = (e) => (e.date?.toDate ? e.date.toDate() : new Date(e.date));

function paperItem(id, p, page, snippet) {
  const meta = [p.journal, p.year].filter(Boolean).join(' ');
  const tags = (p.tags || []).map((t) => `<span class="tag">${c.esc(t)}</span>`).join(' ');
  const hit = page ? ` <span class="hit">p. ${page}</span>` : page === 0 ? ' <span class="hit">in notes</span>' : '';
  const pdf = p.file ? ' <span class="muted">PDF</span>' : '';
  const noAbs = p.abstract ? '' : ' <span class="warn-text">no abstract</span>';
  const snip = snippet ? `<span class="snippet muted">${snippetHtml(snippet)}</span>` : '';
  const authors = showAuthors() && (p.authors || []).length ? `<span class="muted authors">${c.esc(authorLine(p.authors))}</span>` : '';
  const last = (p.presented || []).at(-1);
  const badge = last ? ` <${last.sid ? `a href="#/session/${c.esc(last.sid)}"` : 'span'} class="badge">Presented ${c.esc(presentedOn(last).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))}</${last.sid ? 'a' : 'span'}>` : '';
  // A PDF text hit opens the reader at that page with the search word marked; other rows open the paper page.
  const href = page && p.file ? `#/read/${id}/${page}${ui.q ? '?q=' + encodeURIComponent(ui.q) : ''}` : `#/paper/${id}${page ? '/' + page : ''}`;
  const off = isOffline(id) ? ' <span class="offline-badge" title="Saved on this device">Offline</span>' : '';
  return c.el(`<li class="paper" data-id="${c.esc(id)}"><a href="${href}">${c.esc(p.title)}</a>${authors}
    <span class="muted">${c.esc(meta)}${pdf}${noAbs}${hit}</span>${off}${snip}<span>${badge}${tags}</span></li>`);
}

async function renderSearch() {
  const t0 = performance.now();
  const admin = c.member.role === 'admin';
  const page = c.el(`<section class="card lib"><h1>Library</h1>
    <form id="sf" role="search" class="row"><input id="q" type="search" aria-label="Search the library"
      placeholder="Search titles, tags, notes and PDFs" autocomplete="off"></form>
    <p class="actions"><a class="button primary" href="#/add">Add a paper</a> <a href="#/import">Import PDFs</a></p>
    <div id="chips" class="chips" role="group" aria-label="Filters"></div>
    <div id="lbar" class="listbar"><button type="button" id="sortb" class="plain" aria-haspopup="dialog" disabled><span id="count">Loading…</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
      <button type="button" id="selb" class="link" disabled>Select</button></div>
    <div id="selhead" class="selhead" hidden><button type="button" id="sback" class="link">‹ Back</button><strong id="scount" aria-live="polite"></strong>
      <span><button type="button" id="sall" class="link"></button><button type="button" id="snone" class="link">None</button></span></div>
    <p id="selnote" class="muted" hidden></p>
    <p id="jobline" class="muted" hidden></p>
    <ul id="res" class="list"></ul><p id="end" class="muted end"></p>
    <nav id="selbar" class="selbar" aria-label="Actions on selected papers" hidden></nav></section>`);
  c.view.replaceChildren(page);
  const q = $in(page, '#q'), res = $in(page, '#res'), count = $in(page, '#count'), end = $in(page, '#end');
  q.value = ui.q;
  const tabbar = document.getElementById('tabbar');
  const x = { starred: new Set(), indexed: null, recent: [] };

  // First paint: the newest 50 saved on this device, else (first open here) a small query, while the catalogue loads.
  if (!current() || current().stale) {
    const head = !ui.q && !filterOn(ui.filter) && HEAD_SORT.has(ui.sort) ? readHead() : null;
    if (head?.length) {
      res.replaceChildren(...head.map(([id, p]) => paperItem(id, p)));
      timing.head = Math.round(performance.now() - t0);
    } else if (!readSync() && !ui.q) {
      const h = await withTimeout(getDocs(query(collection(c.db, 'papers'), orderBy('addedAt', 'desc'), limit(PAGE))), 3000, 'first page').catch(() => null);
      if (h && !current() && page.isConnected) {
        res.replaceChildren(...h.docs.map((d) => paperItem(d.id, cleanPaper(d.data()))));
        timing.head = Math.round(performance.now() - t0);
      }
    }
  }
  // Nothing here may hold the page: after a few seconds the saved head stands in (count "50+") and the real
  // catalogue replaces it when it arrives. Failures go to window.__jcTiming (loadError, starredError, ...).
  const why = (k) => (e) => { timing[k] = e?.code || e?.message || String(e); console.warn('library', k, e); };
  const real = loadLibrary();
  // Starred and Recent wait no longer than the catalogue does; they fill in (and the list redraws) when they arrive.
  const wait = readHead()?.length ? 2500 : 8000, starP = loadStarred(c.db, c.user.uid), recentP = loadRecent(c.db, c.user.uid);
  let [cat, starred, recent] = await Promise.all([
    withTimeout(real, wait, 'catalogue').catch((e) => { why('loadError')(e); return headCatalogue(); }),
    withTimeout(starP, Math.min(wait, 3000), 'starred').catch((e) => { why('starredError')(e); return new Set(); }),
    withTimeout(recentP, Math.min(wait, 3000), 'recent').catch((e) => { why('recentError')(e); return []; })]);
  if (!page.isConnected) return;
  x.starred = starred; x.recent = recent;
  starP.then((s) => { if (page.isConnected && s !== starred) { x.starred = starred = s; redraw(); } }).catch(() => {});
  recentP.then((r) => { if (page.isConnected && r !== recent) { x.recent = recent = r; redraw(); } }).catch(() => {});
  // Starred papers are kept for offline reading: fetch any not saved yet, quietly, once the full catalogue is here.
  real.then((full) => syncStarred(starred, full.papers, (id) => apiFetch(`/api/file/${id}`))).catch(() => {});
  let { papers } = cat;
  if (cat.partial) {
    real.then((full) => { if (page.isConnected && cat.partial) { cat = full; papers = full.papers; redraw(); } })
      .catch((e) => { why('loadError')(e); if (page.isConnected) count.title = `Library not refreshed: ${timing.loadError}`; });
  }

  let matchIds = [], info = new Map(), timer = 0, seq = 0, sel = null, mode = 'list';
  const narrowed = () => !!ui.q || filterOn(ui.filter);
  const ok = (id) => papers.has(id) && matches(id, papers.get(id), ui.filter, x);
  const row = (id) => {
    const h = info.get(id) || {};
    const li = paperItem(id, papers.get(id), h.page, h.snippet);
    if (sel) {
      li.classList.add('selecting');
      const box = c.el('<input type="checkbox" class="pick">');
      box.checked = sel.has(id);
      box.setAttribute('aria-label', `Select ${papers.get(id).title}`);
      box.onchange = () => toggle(id, box.checked);
      li.prepend(box);
      li.classList.toggle('picked', sel.has(id));
    }
    return li;
  };
  const appendRows = () => {
    const from = res.children.length;
    matchIds.slice(from, ui.shown).forEach((id) => res.append(row(id)));
    end.textContent = res.children.length < matchIds.length ? `Next ${Math.min(PAGE, matchIds.length - res.children.length)} load as you scroll` : '';
  };
  const redrawRows = () => { res.replaceChildren(); appendRows(); };
  // Infinite scroll: 50 more whenever the end of the list comes near the screen.
  const fill = () => {
    if (!page.isConnected) { io?.disconnect(); return; }
    let guard = 0;
    while (res.children.length < matchIds.length && end.getBoundingClientRect().top < innerHeight + 400 && guard++ < 40) { ui.shown += PAGE; appendRows(); }
  };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((e) => { if (e.some((i) => i.isIntersecting)) fill(); }, { rootMargin: '400px 0px' }) : null;
  io?.observe(end);

  const setCount = (text) => { count.textContent = text; };
  const drawList = () => {
    mode = 'list'; info = new Map();
    const entries = sortEntries([...papers].filter(([id, p]) => matches(id, p, ui.filter, x)), ui.sort, x);
    matchIds = entries.map(([id]) => id);
    ui.shown = Math.max(ui.shown, PAGE);
    redrawRows();
    const more = cat.partial ? '+' : '';
    if (!papers.size) setCount(cat.partial ? 'Still loading the library…' : 'No papers yet. Add the first one.');
    else setCount(`${matchIds.length}${more} ${matchIds.length === 1 && !more ? 'paper' : 'papers'} · ${sortLabel(ui.sort)}`);
    if (!cat.partial && !filterOn(ui.filter) && HEAD_SORT.has(ui.sort)) writeHead(entries);
    drawSel();
  };
  const showHits = (hits, done) => {
    mode = 'search';
    const kept = hits.filter((h) => ok(h.paperId));
    info = new Map(kept.map((h) => [h.paperId, h]));
    matchIds = kept.map((h) => h.paperId);
    ui.shown = PAGE;
    redrawRows();
    setCount(kept.length ? `${kept.length} found${done ? '' : ', searching PDFs…'}` : done ? 'Nothing found.' : 'Searching PDFs…');
    drawSel();
  };
  const show = () => {
    ui.q = q.value.trim();
    const mine = ++seq;
    clearTimeout(timer);
    if (!ui.q) { drawList(); return; }
    const local = searchPapers(cat.index, ui.q, (id) => discussedAt(papers.get(id) || {})).filter((h) => papers.has(h.paperId));
    if (ui.q.length < 3) { showHits(local, true); return; }
    showHits(local, false);
    timer = setTimeout(async () => {
      const server = await serverSearch(ui.q);
      if (mine !== seq || !page.isConnected) return;
      const merged = mergeHits(local, server.hits, (id) => papers.has(id));
      showHits(merged, true);
      if (server.down) setCount(`${merged.length ? `${merged.length} found. ` : ''}PDF search unavailable right now.`);
    }, 250);
  };
  const redraw = () => { drawChips(); show(); };

  // ---- Filter chips ----
  const chipsEl = $in(page, '#chips');
  const chip = (label, on, onclick, extra = '') => {
    const b = c.el(`<button type="button" class="chip${on ? ' on' : ''}" aria-pressed="${on}"${extra}></button>`);
    b.textContent = label;
    if (on && label !== 'All') b.append(c.el('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'));
    b.onclick = onclick;
    return b;
  };
  function drawChips() {
    const n = chipCounts([...papers], x);
    const f = ui.filter;
    const out = [chip('All', !filterOn(f), () => { ui.filter = emptyFilter(); redraw(); })];
    for (const [k, label] of CHIPS) {
      if (k === 'notIndexed' && (!x.indexed || (!n[k] && !f.chips.has(k)))) continue;
      out.push(chip(`${label} · ${n[k]}`, f.chips.has(k), () => { if (f.chips.has(k)) f.chips.delete(k); else f.chips.add(k); redraw(); }));
    }
    out.push(chip(f.tag ? `Tag: ${f.tag}` : 'Tag ▾', !!f.tag, () => (f.tag ? (f.tag = null, redraw()) : tagSheet()), ' aria-haspopup="dialog"'));
    const yr = f.yearFrom != null || f.yearTo != null;
    out.push(chip(yr ? `${f.yearFrom ?? '…'}–${f.yearTo ?? '…'}` : 'Year ▾', yr, () => (yr ? (f.yearFrom = f.yearTo = null, redraw()) : yearSheet()), ' aria-haspopup="dialog"'));
    chipsEl.replaceChildren(...out);
  }
  function tagSheet() {
    const tags = tagCounts([...papers]);
    const d = sheet(c, 'Filter by tag', `<h2 class="sheet-title">Tag</h2><div class="chips wrap" id="tl"></div>`);
    const tl = d.querySelector('#tl');
    if (!tags.length) tl.append(c.el('<p class="muted">No tags yet.</p>'));
    tags.forEach(([t, k]) => tl.append(chip(`${t} · ${k}`, false, () => { ui.filter.tag = t; d.close(); redraw(); })));
  }
  function yearSheet() {
    const d = sheet(c, 'Filter by year', `<h2 class="sheet-title">Year</h2><form class="row" id="yf">
      <input id="yfrom" type="number" inputmode="numeric" min="1900" max="2100" placeholder="From" aria-label="From year">
      <input id="yto" type="number" inputmode="numeric" min="1900" max="2100" placeholder="To" aria-label="To year">
      <button class="primary">Apply</button></form>`);
    d.querySelector('#yf').onsubmit = (e) => {
      e.preventDefault();
      const v = (s) => (d.querySelector(s).value ? Number(d.querySelector(s).value) : null);
      ui.filter.yearFrom = v('#yfrom'); ui.filter.yearTo = v('#yto');
      d.close(); redraw();
    };
  }

  // ---- Sort and view ----
  $in(page, '#sortb').onclick = () => {
    const d = sheet(c, 'Sort', `<h2 class="sheet-title">Sort by</h2><ul class="list">${SORTS.map(([k, l]) => `<li><label class="check-row">
      <input type="radio" name="sort" value="${k}"${k === ui.sort ? ' checked' : ''}><span class="grow">${l}</span></label></li>`).join('')}</ul>
      <ul class="list"><li><label class="check-row"><input type="checkbox" id="sauth"${showAuthors() ? ' checked' : ''}><span class="grow">Show authors</span></label></li></ul>`);
    d.querySelectorAll('input[name=sort]').forEach((r) => { r.onchange = () => {
      ui.sort = r.value;
      try { localStorage.setItem(SORT_KEY, ui.sort); } catch { /* private */ }
      d.close(); ui.q = ''; q.value = ''; show();
    }; });
    d.querySelector('#sauth').onchange = (e) => { try { localStorage.setItem(AUTHORS_KEY, e.target.checked ? '1' : '0'); } catch { /* private */ } redrawRows(); };
  };

  // ---- Select mode ----
  const selhead = $in(page, '#selhead'), lbar = $in(page, '#lbar'), selbar = $in(page, '#selbar'), selnote = $in(page, '#selnote');
  const allCount = () => (narrowed() ? Math.min(matchIds.length, SELECT_CAP) : res.children.length);
  function startSelect(ids) { sel = new Set(ids); redrawRows(); drawSel(); }
  function stopSelect() { sel = null; redrawRows(); drawSel(); }
  function toggle(id, on = !sel.has(id)) {
    if (on) sel.add(id); else sel.delete(id);
    const li = res.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    if (li) { li.classList.toggle('picked', on); li.querySelector('.pick').checked = on; }
    drawSel();
  }
  function drawSel() {
    const on = !!sel;
    selhead.hidden = !on; lbar.hidden = on; selbar.hidden = !on;
    if (tabbar) tabbar.hidden = on;
    document.body.classList.toggle('selecting', on);
    if (!on) { selnote.hidden = true; return; }
    for (const id of [...sel]) if (!papers.has(id)) sel.delete(id);
    $in(page, '#scount').textContent = `${sel.size} selected`;
    $in(page, '#sall').textContent = `All ${allCount()}`;
    const all = narrowed() && sel.size && sel.size === allCount();
    selnote.hidden = !all;
    selnote.textContent = all ? `All ${sel.size} matching papers selected${matchIds.length > SELECT_CAP ? ` (the first ${SELECT_CAP} of ${matchIds.length})` : ''}.` : '';
    const ids = [...sel];
    const btn = (key, label, act, primary = false) => {
      const b = c.el(`<button type="button"${primary ? ' class="on"' : ''}><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ICON[key]}</svg><span></span></button>`);
      b.querySelector('span').textContent = label;
      b.disabled = !ids.length;
      b.onclick = act;
      return b;
    };
    const after = () => { if (page.isConnected) { drawChips(); show(); } };
    const pick = (missing) => { if (page.isConnected) startSelect(missing); else { ui.pendingSel = missing; location.hash = '#/library'; } };
    const out = [btn('add', 'Add to…', () => addToSheet(c, ids, after))];
    if (admin) {
      if (ui.filter.chips.has('notIndexed')) {
        const n = ids.filter((id) => papers.get(id)?.file).length;
        out.push(btn('refresh', `Reindex ${n}`, () => reindexSelected(c, ids, () => { drawChips(); show(); }, pick), true));
      } else {
        const n = ids.filter((id) => refreshId(papers.get(id) || {})).length;
        out.push(btn('refresh', `Refresh ${n}`, () => refreshSelected(c, ids, after, pick), narrowed()));
      }
    }
    const allStarred = ids.length && ids.every((id) => x.starred.has(id));
    out.push(btn('star', allStarred ? 'Unstar' : 'Star', () => starSelected(c, ids, after)));
    out.push(btn('more', 'More', () => moreSheet(c, ids, {
      reindex: () => reindexSelected(c, ids, after, pick),
      fill: () => fillSelected(c, ids, after, pick),
      remove: () => removeSelected(c, ids, () => { ids.forEach((id) => sel?.delete(id)); after(); }),
    })));
    selbar.style.gridTemplateColumns = `repeat(${out.length}, minmax(0, 1fr))`;
    selbar.replaceChildren(...out);
  }
  $in(page, '#selb').onclick = () => startSelect([]);
  $in(page, '#sback').onclick = stopSelect;
  $in(page, '#snone').onclick = () => { sel = new Set(); redrawRows(); drawSel(); };
  $in(page, '#sall').onclick = () => {
    sel = new Set(selectAll([...res.children].map((li) => li.dataset.id), matchIds, narrowed()));
    if (narrowed()) { ui.shown = Math.max(ui.shown, sel.size); }
    redrawRows(); drawSel();
  };
  // Tap a row to tick it while selecting; long-press any row to start.
  let press = null, eat = false;
  res.addEventListener('pointerdown', (e) => {
    eat = false;
    const li = e.target.closest('li.paper');
    if (!li || sel || e.button > 0) return;
    press = { x: e.clientX, y: e.clientY, t: setTimeout(() => { press = null; eat = true; startSelect([li.dataset.id]); navigator.vibrate?.(10); }, 500) };
  });
  const cancel = () => { if (press) { clearTimeout(press.t); press = null; } };
  res.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); });
  res.addEventListener('pointerup', () => { cancel(); if (eat) setTimeout(() => { eat = false; }, 400); });
  res.addEventListener('pointercancel', cancel);
  res.addEventListener('contextmenu', (e) => { if (e.target.closest('li.paper')) e.preventDefault(); });
  res.addEventListener('click', (e) => {
    const li = e.target.closest('li.paper');
    if (!li) return;
    if (eat) { e.preventDefault(); eat = false; return; }
    if (!sel || e.target.classList.contains('pick')) return;
    e.preventDefault();
    toggle(li.dataset.id);
  });

  // ---- A refresh or reindex still running (or just finished) ----
  const jobline = $in(page, '#jobline');
  const drawJob = () => {
    if (!page.isConnected) return offJob();
    jobline.hidden = !job;
    if (!job) return;
    jobline.replaceChildren(c.el(`<span>${job.kind === 'refresh' ? 'Refreshing' : 'Reindexing'} ${job.running ? `${job.done} of ${job.total}` : `done (${job.total})`} · </span>`));
    const b = c.el('<button type="button" class="link">Show</button>');
    b.onclick = () => jobSheet(c, (ids) => startSelect(ids));
    jobline.append(b);
  };
  const offJob = onJob(drawJob);
  drawJob();

  q.oninput = show;
  $in(page, '#sf').onsubmit = (e) => { e.preventDefault(); q.blur(); };
  drawChips();
  $in(page, '#sortb').disabled = false; $in(page, '#selb').disabled = false; // wired up now the catalogue is here
  if (ui.pendingSel) { sel = new Set(ui.pendingSel); ui.pendingSel = null; }
  show();
  timing.list = Math.round(performance.now() - t0);
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { if (page.isConnected) void cat.index; });
  indexedIds(c).then((s) => { if (s && page.isConnected) { x.indexed = s; drawChips(); if (ui.filter.chips.has('notIndexed')) show(); } });
}

async function renderAdd() {
  const page = c.el(`<section class="card"><h1>Add a paper</h1>
    <form id="lf" class="row"><input id="pid" aria-label="DOI or PubMed ID" placeholder="DOI, PubMed ID or ATOTW 551" required>
      <button class="primary">Look up</button></form>
    <p id="lmsg" class="muted">Paste a DOI (10.xxxx/…), a doi.org link or a PubMed ID.</p><div id="prev"></div></section>`);
  c.view.replaceChildren(page);
  const msg = $in(page, '#lmsg');
  $in(page, '#lf').onsubmit = async (e) => {
    e.preventDefault();
    msg.textContent = 'Looking up…';
    $in(page, '#prev').replaceChildren();
    let p;
    try {
      const r = await apiFetch('/api/lookup?id=' + encodeURIComponent($in(page, '#pid').value.trim()));
      p = await r.json();
      if (!r.ok) { msg.textContent = p.error || 'Not found.'; return; }
    } catch { msg.textContent = 'Lookup failed. Check the connection and try again.'; return; }
    if (p.doi) {
      const dup = await getDocs(query(collection(c.db, 'papers'), where('doi', '==', p.doi)));
      if (!dup.empty) {
        msg.replaceChildren(c.el(`<span>Already in the library: <a href="#/paper/${dup.docs[0].id}">${c.esc(p.title)}</a></span>`));
        return;
      }
    }
    msg.textContent = '';
    const prev = c.el(`<div><h2>${c.esc(p.title)}</h2>
      <p class="muted">${c.esc(authorLine(p.authors))}<br>${c.esc([p.journal, p.year].filter(Boolean).join(' '))}</p>
      <form id="af" class="stack">
        <label>Tags, comma separated <input id="tags" placeholder="airway, obstetric, exam"></label>
        <label>Why read it (one line) <input id="why" maxlength="200"></label>
        <button class="primary">Save to library</button></form></div>`);
    $in(page, '#prev').replaceChildren(prev);
    $in(prev, '#af').onsubmit = async (ev) => {
      ev.preventDefault();
      const ref = await addPaper(p, tagList($in(prev, '#tags').value), $in(prev, '#why').value.trim());
      dirty();
      location.hash = `#/paper/${ref.id}`;
    };
  };
}

function addPaper(p, tags, why = '') {
  return addDoc(collection(c.db, 'papers'), {
    doi: p.doi || '', pmid: p.pmid || '', title: p.title, authors: (p.authors || []).slice(0, 50),
    journal: p.journal || '', year: p.year || null, abstract: (p.abstract || '').slice(0, 20000),
    oa: { status: p.oa?.status || 'unknown', license: p.oa?.license || null, url: p.oa?.url || null },
    tags, why, addedBy: c.user.uid, addedAt: serverTimestamp(), changedAt: serverTimestamp(),
  });
}

// Stores the PDF, then its per-page text in the Worker's search index. Returns null on success, else the reason.
async function storePdf(id, buf, pages) {
  const r = await apiFetch(`/api/file/${id}`, { method: 'PUT', body: buf, headers: { 'Content-Type': 'application/pdf' } });
  if (!r.ok) return (await r.json().catch(() => ({}))).error || 'Upload refused.';
  const ix = await apiFetch(`/api/index/${id}`, { method: 'PUT', body: JSON.stringify({ pages }), headers: { 'Content-Type': 'application/json' } })
    .catch(() => null);
  if (!ix?.ok) console.warn('PDF stored, but its text was not indexed for search');
  else markIndexed(id);
  await updateDoc(doc(c.db, 'papers', id), { file: { pages: pages.length, size: buf.byteLength }, changedAt: serverTimestamp() });
  return null;
}

const MAX_PDF = 25 * 1024 * 1024;
const fileTitle = (name) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled PDF';

async function renderImport() {
  const page = c.el(`<section class="card"><p><a href="#/library">← Library</a></p><h1>Import PDFs</h1>
    <p class="muted">Choose PDFs or a whole folder. Each paper's DOI is read from its first pages and the details filled in;
      PDFs without a DOI are added under their file name; Anaesthesia Tutorial of the Week PDFs are found by their number (ATOTW 551). Papers already in the library are skipped.</p>
    <form id="if" class="stack">
      <label>PDF files <input type="file" id="files" accept="application/pdf" multiple></label>
      <label>Or a folder <input type="file" id="folder" webkitdirectory></label>
      <label>Tags for all, comma separated <input id="itags" placeholder="airway, exam"></label>
      <button class="primary">Import</button></form>
    <p id="imsg" class="muted"></p><ul id="ires" class="list"></ul></section>`);
  c.view.replaceChildren(page);
  const msg = $in(page, '#imsg'), res = $in(page, '#ires');
  $in(page, '#if').onsubmit = async (e) => {
    e.preventDefault();
    const files = [...$in(page, '#files').files, ...$in(page, '#folder').files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { msg.textContent = 'Choose some PDFs first.'; return; }
    const btn = $in(page, '#if button');
    btn.disabled = true;
    res.replaceChildren();
    const tags = tagList($in(page, '#itags').value);
    const { papers } = await loadLibrary();
    const byDoi = new Map([...papers].filter(([, p]) => p.doi).map(([id, p]) => [p.doi.toLowerCase(), [id, p]]));
    const byTitle = new Map([...papers].map(([id, p]) => [p.title.toLowerCase(), [id, p]]));
    const { extractPages } = await import('./pdf.js');
    const counts = { added: 0, skipped: 0, failed: 0 };
    for (const [i, f] of files.entries()) {
      msg.textContent = `Importing ${i + 1} of ${files.length}…`;
      const row = c.el(`<li><span><strong>${c.esc(f.name)}</strong><br><span class="muted">Reading…</span></span></li>`);
      res.append(row);
      const say = (html, kind) => { row.querySelector('.muted').innerHTML = html; counts[kind]++; };
      try {
        if (f.size > MAX_PDF) { say('Skipped: over 25 MB.', 'failed'); continue; }
        const buf = await f.arrayBuffer();
        const pages = await extractPages(buf.slice(0));
        // An ATOTW number in the file name wins: those PDFs may print no DOI, and page 2 can cite other papers.
        const found = atotwDoi(f.name) || findDoi(pages.slice(0, 2).join(' ')) || atotwDoi(pages[0]);
        let p = null;
        if (found) {
          const r = await apiFetch('/api/lookup?id=' + encodeURIComponent(found));
          if (r.ok) p = await r.json();
        }
        p = p || { title: fileTitle(f.name), doi: '' };
        const dup = (p.doi && byDoi.get(p.doi.toLowerCase())) || byTitle.get(p.title.toLowerCase());
        let id;
        if (dup) {
          const [did, dp] = dup;
          if (dp.file || !mayEdit(dp)) { say(`Already in the library: <a href="#/paper/${did}">${c.esc(dp.title)}</a>`, 'skipped'); continue; }
          id = did; // in the library without a PDF: attach this one
        } else {
          id = (await addPaper(p, tags)).id;
          const entry = [id, { ...p, addedBy: c.user.uid }];
          if (p.doi) byDoi.set(p.doi.toLowerCase(), entry);
          byTitle.set(p.title.toLowerCase(), entry);
        }
        const err = await storePdf(id, buf, pages);
        if (err) { say(`Added without the PDF: ${c.esc(err)}`, 'failed'); continue; }
        (dup ? dup[1] : byTitle.get(p.title.toLowerCase())[1]).file = { pages: pages.length };
        say(`<a href="#/paper/${id}">${c.esc(p.title)}</a>${p.doi ? '' : ' · no DOI found, named from the file'}`, 'added');
      } catch (err) { console.error(err); say('Could not read or upload this PDF.', 'failed'); }
    }
    dirty();
    btn.disabled = false;
    msg.textContent = `Done: ${counts.added} added, ${counts.skipped} already there, ${counts.failed} failed.`;
  };
}

async function renderPaper(id, hitPage) {
  const snap = await getDoc(doc(c.db, 'papers', id));
  if (!snap.exists()) { forget(id); c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/library">Library</a></p></section>')); return; }
  const p = cleanPaper(snap.data());
  const [ns, lists, starred] = await Promise.all([getDocs(collection(c.db, 'papers', id, 'notes')),
    loadLists(c.db, c.user.uid, c.member.role === 'admin').catch(() => []), loadStarred(c.db, c.user.uid)]);
  touchRecent(c.db, c.user.uid, id);
  const notes = ns.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const mine = notes.find((n) => n.uid === c.user.uid);
  document.title = `${p.title} · Paper · Journal club`;
  const links = [
    p.doi && `<a href="https://doi.org/${c.esc(p.doi)}" target="_blank" rel="noopener">Publisher page</a>`,
    p.doi && `<a href="${NUS_PROXY}${encodeURIComponent('https://doi.org/' + p.doi)}" target="_blank" rel="noopener">Via NUS Libraries</a>`,
    p.pmid && `<a href="https://pubmed.ncbi.nlm.nih.gov/${c.esc(p.pmid)}/" target="_blank" rel="noopener">PubMed</a>`,
  ].filter(Boolean).join(' · ');
  const meta = [p.journal, p.year].filter(Boolean).map(c.esc).join(' · ');
  const doiLink = p.doi ? `<a href="https://doi.org/${c.esc(p.doi)}" target="_blank" rel="noopener">DOI</a>` : '';
  const page = c.el(`<section class="card paperpage"><p class="eyebrow">PAPER</p><p class="back"><a href="#/library">← Library</a></p><h1>${c.esc(p.title)}</h1>
    <p class="muted meta">${[meta, doiLink].filter(Boolean).join(' · ')}</p>
    ${(p.tags || []).length ? `<p class="tagrow">${(p.tags || []).map((t) => `<span class="tag">${c.esc(t)}</span>`).join(' ')}</p>` : ''}
    ${p.abstract ? `<div class="abstract-open"><h2>Abstract</h2>${ABSTRACT_NOTE[p.abstractSource] ? `<p class="muted">${ABSTRACT_NOTE[p.abstractSource]}</p>` : ''}<div class="abstract">${abstractSections(p.abstract)
      .map((x) => `<p>${x.label ? `<strong>${c.esc(x.label)}:</strong> ` : ''}${c.esc(x.text)}</p>`).join('')}</div></div>` : ''}
    <p class="actions compact"><button type="button" id="star" class="star-btn"></button><button type="button" id="addto">Lists and tags…</button><button type="button" id="editd">Edit details</button></p>
    <p class="muted" id="inlists"></p>
    ${links ? `<p class="links">${links}</p>` : ''}
    ${p.why ? `<p><strong>Why read it:</strong> ${c.esc(p.why)}</p>` : ''}
    ${(p.manual || []).length ? `<p class="muted" id="handnote">Edited by hand (${c.esc(p.manual.join(', '))}). <button type="button" class="link" id="unhand">Let Refresh update these again</button></p>` : ''}
    <h2>Full Text PDF</h2><div id="file"></div>
    <h2>Journal club</h2><div id="jc"><p class="muted">Loading…</p></div>
    <h2>Notes</h2>
    <form id="nf" class="stack"><label>Your note <textarea id="note" rows="3" maxlength="4000"></textarea></label>
      <button class="primary">Save note</button></form>
    <ul id="notes" class="list"></ul>
    <div id="edit"></div></section>`);
  c.view.replaceChildren(page);

  // PDF: open, or upload.
  const file = $in(page, '#file');
  if (p.file) {
    const open = c.el(`<button class="primary">Open PDF${hitPage ? ` at page ${hitPage}` : ''}</button>`);
    open.onclick = () => { location.hash = `#/read/${id}${hitPage ? '/' + hitPage : ''}`; };
    file.append(open, c.el(`<span class="muted"> ${p.file.pages} pages</span>`));
    if (isOffline(id)) file.append(c.el(' <span class="offline-badge" title="Saved on this device">Offline copy</span>'));
  } else if (mayEdit(p)) {
    const up = c.el(`<form id="uf" class="stack">
      <input type="file" id="pdf" accept="application/pdf" aria-label="PDF file">
      <button class="primary">Upload PDF</button><p id="umsg" class="muted"></p></form>`);
    file.append(up);
    up.onsubmit = async (e) => {
      e.preventDefault();
      const msg = $in(up, '#umsg');
      const f = $in(up, '#pdf').files[0];
      if (!f) { msg.textContent = 'Choose a PDF.'; return; }
      msg.textContent = 'Reading the PDF…';
      try {
        const buf = await f.arrayBuffer();
        const { extractPages } = await import('./pdf.js');
        const pages = await extractPages(buf.slice(0));
        msg.textContent = 'Uploading…';
        const err = await storePdf(id, buf, pages);
        if (err) { msg.textContent = err; return; }
        dirty(); renderPaper(id, null);
      } catch (err) { console.error(err); msg.textContent = 'Could not read or upload this PDF.'; }
    };
  } else {
    file.append(c.el('<p class="muted">No PDF. The person who added the paper can upload one.</p>'));
  }

  // Notes.
  if (mine) $in(page, '#note').value = mine.text;
  const nl = $in(page, '#notes');
  notes.filter((n) => n.text).forEach((n) => nl.append(c.el(`<li><span><strong>${c.esc(n.name || 'Member')}</strong><br>${c.esc(n.text)}</span></li>`)));
  $in(page, '#nf').onsubmit = async (e) => {
    e.preventDefault();
    await setDoc(doc(c.db, 'papers', id, 'notes', c.user.uid), {
      text: $in(page, '#note').value.trim(), rating: 0, // ratings are retired; the rules still expect the field
      name: c.member.name || c.user.displayName || c.user.email, updatedAt: serverTimestamp(),
    });
    apiFetch(`/api/index/${id}/notes`, { method: 'POST' }).catch(() => {}); // notes are searched server-side
    renderPaper(id, hitPage);
  };

  // Journal club: sessions this paper was presented at, with members' take-home points, and a way to plan one.
  (async () => {
    const jc = $in(page, '#jc');
    const ss = await getDocs(query(collection(c.db, 'sessions'), where('paperId', '==', id)));
    const sessions = ss.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.date.toMillis() - a.date.toMillis());
    const pts = await Promise.all(sessions.map((s) => getDocs(collection(c.db, 'sessions', s.id, 'points'))));
    jc.replaceChildren();
    sessions.forEach((s, i) => {
      const when = s.date.toDate().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const box = c.el(`<div class="jc-session"><p><a href="#/session/${c.esc(s.id)}">${c.esc(when)}</a> <span class="muted">Presenter: ${c.esc(s.presenterName || '—')}</span></p></div>`);
      const texts = pts[i].docs.map((d) => d.data().text).filter(Boolean);
      if (texts.length) { const ul = c.el('<ul class="list"></ul>'); texts.forEach((t) => ul.append(c.el(`<li><span>${c.esc(t)}</span></li>`))); box.append(ul); }
      jc.append(box);
    });
    if (!sessions.length) jc.append(c.el('<p class="muted">Not presented yet.</p>'));
    jc.append(c.el(`<p><a class="button primary" href="#/plan/${c.esc(id)}">Plan a session</a></p>`));
    // Older sessions pre-date the `presented` summary on the paper: bring it in step (any member may write it).
    const want = sessions.map((s) => s.id).sort().join();
    if ((p.presented || []).map((e) => e.sid).sort().join() !== want) {
      updateDoc(snap.ref, { presented: sessions.map((s) => ({ sid: s.id, date: s.date })).reverse() }).then(dirty, () => {});
    }
  })().catch(() => {});

  // Star, and the lists it is in: the Add to… sheet ticks lists (and tags) for this one paper.
  const star = $in(page, '#star');
  const drawStar = () => {
    const on = starred.has(id);
    star.innerHTML = `${STAR}<span>${on ? 'Starred' : 'Star'}</span>`;
    star.setAttribute('aria-pressed', String(on));
    star.classList.toggle('on', on);
  };
  star.onclick = async () => {
    star.disabled = true;
    await setStarred(c.db, c.user.uid, [id], !starred.has(id)).catch(() => {});
    star.disabled = false; drawStar();
    if (starred.has(id) && p.file) syncStarred(starred, new Map([[id, p]]), (x) => apiFetch(`/api/file/${x}`)).catch(() => {}); // starred papers are kept for offline
  };
  drawStar();
  const inl = [...(starred.has(id) ? ['Starred'] : []), ...lists.filter((l) => !l.starred && l.paperIds.includes(id)).map((l) => l.name)];
  $in(page, '#inlists').textContent = inl.length ? `In ${inl.join(', ')}` : 'Not in any of your lists yet.';
  const unhand = page.querySelector('#unhand');
  if (unhand) unhand.onclick = async () => { unhand.disabled = true; await releaseHand(c, id).catch(() => {}); renderPaper(id, hitPage); };
  $in(page, '#addto').onclick = () => { current() ? addToSheet(c, [id], () => renderPaper(id, hitPage)) : loadLibrary().then(() => addToSheet(c, [id], () => renderPaper(id, hitPage))); };

  // Edit details: any member (title, authors, journal, year, DOI, PubMed ID, abstract, tags, why). The adder or an
  // admin also gets the link to the separate removal page.
  $in(page, '#editd').onclick = () => editSheet(c, id, p, () => renderPaper(id, hitPage));
  if (mayEdit(p)) $in(page, '#edit').append(c.el(`<p class="muted"><a href="#/remove/${c.esc(id)}">Remove this paper or its PDF…</a></p>`));

  // Any member can flag the PDF or the whole paper for an admin to review.
  const fl = c.el(`<details id="flagbox"><summary>Flag for removal</summary><form id="ff" class="stack">
    <label>What <select id="fwhat">${p.file ? '<option value="pdf">The PDF</option>' : ''}<option value="paper">The whole paper</option></select></label>
    <label>Reason <textarea id="freason" rows="2" maxlength="500" required></textarea></label>
    <button class="primary">Send flag</button><p id="fmsg" class="muted"></p></form></details>`);
  $in(fl, '#ff').onsubmit = async (e) => {
    e.preventDefault();
    const reason = $in(fl, '#freason').value.trim();
    if (!reason) return;
    try {
      await addDoc(collection(c.db, 'flags'), {
        paperId: id, paperTitle: p.title, what: $in(fl, '#fwhat').value, reason,
        by: c.user.uid, byName: c.member.name || c.user.displayName || c.user.email, at: serverTimestamp(),
      });
      $in(fl, '#ff').replaceChildren(c.el('<p>Thanks. An admin will review it.</p>'));
    } catch { $in(fl, '#fmsg').textContent = 'Could not send the flag.'; }
  };
  $in(page, '#edit').append(fl);
}

// Separate removal page: the adder or an admin removes the PDF, or the paper after typing its title.
async function renderRemove(id) {
  const snap = await getDoc(doc(c.db, 'papers', id));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/library">Library</a></p></section>')); return; }
  const p = cleanPaper(snap.data());
  if (!mayEdit(p)) { c.view.replaceChildren(c.el(`<section class="card"><h1>Not allowed</h1><p>Only the person who added this paper, or an admin, can remove it.</p><p><a href="#/paper/${c.esc(id)}">Back to the paper</a></p></section>`)); return; }
  const page = c.el(`<section class="card"><p><a href="#/paper/${c.esc(id)}">← Back to the paper</a></p><h1>Remove</h1>
    <p><strong>${c.esc(p.title)}</strong></p>
    ${p.file ? '<h2>Remove the PDF only</h2><p class="muted">The paper stays in the library; the stored file and its search text go.</p><button id="rpdf" class="danger-btn">Remove PDF</button>' : ''}
    <h2>Remove the whole paper</h2>
    <p class="muted">This also removes its PDF. Notes and votes on it are no longer reachable. Type the title to confirm.</p>
    <form id="rf" class="stack"><label>Title <input id="rtitle" autocomplete="off" aria-label="Type the paper title"></label>
      <button id="rpaper" class="danger-btn" disabled>Remove paper</button></form><p id="rmsg" class="muted"></p></section>`);
  c.view.replaceChildren(page);
  const msg = $in(page, '#rmsg');
  const clearFlags = async () => {
    if (c.member.role !== 'admin') return;
    const fs = await getDocs(query(collection(c.db, 'flags'), where('paperId', '==', id)));
    await Promise.all(fs.docs.map((d) => deleteDoc(d.ref)));
  };
  const norm = (t) => t.trim().replace(/\s+/g, ' ').toLowerCase();
  $in(page, '#rtitle').oninput = () => { $in(page, '#rpaper').disabled = norm($in(page, '#rtitle').value) !== norm(p.title); };
  if (p.file) {
    $in(page, '#rpdf').onclick = async () => {
      if (!confirm('Remove the stored PDF?')) return;
      try {
        await apiFetch(`/api/file/${id}`, { method: 'DELETE' }); // also drops its pages from search
        forgetOffline(id);
        await deleteDoc(doc(c.db, 'texts', id)).catch(() => {}); // pre-D1 copy, if any
        await updateDoc(doc(c.db, 'papers', id), { file: null, changedAt: serverTimestamp() });
        await clearFlags();
        dirty(); location.hash = `#/paper/${id}`;
      } catch { msg.textContent = 'Could not remove the PDF.'; }
    };
  }
  $in(page, '#rf').onsubmit = async (e) => {
    e.preventDefault();
    if (norm($in(page, '#rtitle').value) !== norm(p.title)) return;
    try {
      if (p.file) { await apiFetch(`/api/file/${id}`, { method: 'DELETE' }); forgetOffline(id); await deleteDoc(doc(c.db, 'texts', id)).catch(() => {}); }
      await apiFetch(`/api/index/${id}`, { method: 'DELETE' }).catch(() => {});
      await deleteDoc(doc(c.db, 'papers', id));
      await clearFlags().catch(() => {});
      forget(id); location.hash = '#/library';
    } catch { msg.textContent = 'Could not remove the paper.'; }
  };
}

// Admin, once after the move to server search: copies the old texts/<paper> pages into the Worker's index
// and indexes every paper's notes. Safe to run again.
async function renderReindex() {
  const page = c.el(`<section class="card"><p><a href="#/library">← Library</a></p><h1>Rebuild PDF search</h1>
    <p class="muted">Copies stored PDF text and notes into the search index. Safe to run more than once.</p>
    <button id="go" class="primary">Rebuild</button><p id="rmsg" class="muted"></p></section>`);
  c.view.replaceChildren(page);
  const msg = $in(page, '#rmsg'), go = $in(page, '#go');
  if (c.member.role !== 'admin') { go.remove(); msg.textContent = 'Admins only.'; return; }
  go.onclick = async () => {
    go.disabled = true;
    let body = {}, done = { texts: 0, notes: 0 };
    try {
      while (body) {
        const r = await apiFetch('/api/backfill', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || r.status);
        done[out.phase] += out.indexed;
        msg.textContent = `Working… ${done.texts} PDFs and ${done.notes} papers' notes so far.`;
        body = out.next;
      }
      msg.textContent = `Done: ${done.texts} PDFs and ${done.notes} papers' notes indexed.`;
    } catch (e) { msg.textContent = `Stopped: ${e.message}. Run it again to carry on.`; }
    go.disabled = false;
  };
}
