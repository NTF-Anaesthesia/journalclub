// Select mode's actions on many papers at once, and the sheets and snackbar they use.
// Members: Add to… (reading lists and tags), Star, citations. Admins also: Refresh abstracts, Fill missing details, Reindex PDFs,
// Remove, and the Find duplicates page with merge.
import {
  doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, writeBatch, collection, query, where,
  serverTimestamp, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { current, forget, restore, dirty } from './catalogue.js';
import { loadLists, loadStarred, setStarred, starredStub } from './prefs.js';
import { tagCounts, triState } from './filters.js';
import { refreshId, refreshChanges, fillChanges } from './refresh.js';
import { vancouverList, bibtex } from './cite.js';
import { findDuplicates, pickKeep, keepAllowed, mergePaper, mergeNotes } from './dupes.js';
import { cleanPaper } from './abstract.js';

const api = (c, path, init = {}) => c.user.getIdToken().then((t) => fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } }));
const isAdmin = (c) => c.member.role === 'admin';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// A bottom sheet: a modal <dialog>, removed when closed. Tapping the backdrop closes it.
export function sheet(c, label, html) {
  const d = c.el(`<dialog class="sheet" aria-label="${c.esc(label)}"><span class="sheet-grip" aria-hidden="true"></span>${html}</dialog>`);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  return d;
}

// One snackbar at a time. `undo` shows an Undo button; `done` runs when it times out (or another replaces it).
let snackNow = null;
export function snack(c, text, { undo, done, ms = 6000 } = {}) {
  if (snackNow) snackNow.finish();
  const s = c.el(`<div class="snack" role="status"><span></span>${undo ? '<button type="button" class="link">Undo</button>' : ''}</div>`);
  s.querySelector('span').textContent = text;
  let over = false;
  const me = {
    finish() { if (over) return; over = true; clearTimeout(t); s.remove(); if (snackNow === me) snackNow = null; done?.(); },
  };
  const t = setTimeout(() => me.finish(), ms);
  if (undo) s.querySelector('button').onclick = async () => { over = true; clearTimeout(t); s.remove(); snackNow = null; await undo(); };
  document.body.append(s);
  snackNow = me;
  return me;
}

// ---- Add to… : reading lists and tags in one sheet, tri-state over the selected papers ----
export async function addToSheet(c, ids, onChange) {
  const lib = current();
  const uid = c.user.uid;
  const [lists, starred] = await Promise.all([loadLists(c.db, uid, isAdmin(c)), loadStarred(c.db, uid)]);
  if (!lists.some((l) => l.starred)) lists.unshift(starredStub(uid));
  const star = lists.find((l) => l.starred);
  star.paperIds = [...starred];
  const paper = (id) => lib.papers.get(id) || { tags: [] };
  const rows = new Map(); // key -> { kind, name, list?, init, now }
  for (const l of lists) {
    const s = triState(ids, (id) => l.paperIds.includes(id));
    rows.set('l:' + l.id, { kind: 'list', name: l.name, list: l, init: s, now: s });
  }
  for (const [t] of tagCounts([...lib.papers])) {
    const s = triState(ids, (id) => (paper(id).tags || []).includes(t));
    rows.set('t:' + t, { kind: 'tag', name: t, init: s, now: s });
  }
  const n = ids.length;
  const d = sheet(c, `Add ${plural(n, 'paper')} to`, `<div class="sheet-head"><button type="button" class="link" id="cx">Cancel</button>
      <strong>Add ${plural(n, 'paper')} to…</strong><button type="button" class="link" id="sv">Save</button></div>
    <input id="af" type="search" autocomplete="off" aria-label="Find or create a list or tag" placeholder="Find or create a private list or shared tag">
    <div id="mk"></div>
    <h3 class="sheet-h">Private lists <span class="muted">· only you see them</span></h3><ul id="al" class="list"></ul>
    <h3 class="sheet-h">Shared tags <span class="muted">· every member sees them</span></h3><div id="at" class="chips wrap"></div>
    <p class="muted">Tap once to add to all ${n}, again to remove from all ${n}. A dashed tag or a part-filled box is on some of them; Save leaves it as is unless you tap it.</p>`);
  const find = d.querySelector('#af');
  const note = (r) => (r.now === 'all' ? `all ${n}` : r.now === 'some' ? `${ids.filter((id) => r.kind === 'list' ? r.list.paperIds.includes(id) : (paper(id).tags || []).includes(r.name)).length} of ${n}` : '');
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    const al = d.querySelector('#al'), at = d.querySelector('#at'), mk = d.querySelector('#mk');
    al.replaceChildren(); at.replaceChildren(); mk.replaceChildren();
    for (const [key, r] of rows) {
      if (q && !r.name.toLowerCase().includes(q)) continue;
      if (r.kind === 'list') {
        const li = c.el(`<li><label class="check-row"><input type="checkbox"><span class="grow"></span><span class="muted"></span></label></li>`);
        const box = li.querySelector('input');
        box.checked = r.now === 'all'; box.indeterminate = r.now === 'some';
        li.querySelector('.grow').textContent = r.name;
        li.querySelector('.muted').textContent = note(r);
        box.onchange = () => { r.now = box.checked ? 'all' : 'none'; draw(); };
        al.append(li);
      } else {
        const b = c.el(`<button type="button" class="chip${r.now === 'all' ? ' on' : r.now === 'some' ? ' some' : ''}" aria-pressed="${r.now === 'all' ? 'true' : r.now === 'some' ? 'mixed' : 'false'}"></button>`);
        b.textContent = r.now === 'some' ? `${r.name} · ${note(r)}` : r.name;
        b.onclick = () => { r.now = r.now === 'all' ? 'none' : 'all'; draw(); };
        at.append(b);
      }
    }
    if (q) {
      const name = find.value.trim();
      if (![...rows.values()].some((r) => r.kind === 'list' && r.name.toLowerCase() === q)) {
        const p = c.el('<p class="mk-row"><button type="button" class="link" id="nl"></button></p>');
        p.querySelector('#nl').textContent = `+ New private list “${name}”`;
        p.querySelector('#nl').onclick = async () => {
          const ref = await addDoc(collection(c.db, 'lists'), { name: name.slice(0, 80), about: '', paperIds: [], createdBy: uid,
            createdAt: serverTimestamp(), visibility: 'private' });
          rows.set('l:' + ref.id, { kind: 'list', name, list: { id: ref.id, name, paperIds: [], mine: true }, init: 'none', now: 'all' });
          find.value = ''; draw();
        };
        mk.append(p);
      }
      const tag = q.replace(/,/g, ' ').trim();
      if (tag && !rows.has('t:' + tag)) {
        const b = c.el('<p class="mk-row"><button type="button" class="link"></button></p>');
        b.firstChild.textContent = `+ New shared tag “${tag}”`;
        b.firstChild.onclick = () => { rows.set('t:' + tag, { kind: 'tag', name: tag, init: 'none', now: 'all' }); find.value = ''; draw(); };
        mk.append(b);
      }
    }
  };
  find.oninput = draw;
  draw();
  d.querySelector('#cx').onclick = () => d.close();
  d.querySelector('#sv').onclick = async () => {
    const btn = d.querySelector('#sv'); btn.disabled = true;
    try {
      const undo = await applyAddTo(c, ids, [...rows.values()].filter((r) => r.now !== r.init));
      d.close();
      onChange?.();
      if (undo.count) snack(c, `Saved ${plural(undo.count, 'change')} to ${plural(n, 'paper')}`, { undo: async () => { await undo.run(); onChange?.(); snack(c, 'Undone'); } });
    } catch (e) { console.error(e); btn.disabled = false; alert('Could not save. Check the connection and try again.'); }
  };
}

// Writes the changed rows; returns { count, run } where run() puts everything back.
async function applyAddTo(c, ids, changed) {
  const lib = current(), uid = c.user.uid;
  const back = [];
  for (const r of changed.filter((x) => x.kind === 'list')) {
    const before = new Set(r.list.paperIds);
    if (r.list.starred) {
      const on = r.now === 'all';
      const touched = ids.filter((id) => before.has(id) !== on);
      await setStarred(c.db, uid, touched, on);
      back.push(() => setStarred(c.db, uid, touched, !on));
      continue;
    }
    const ref = doc(c.db, 'lists', r.list.id);
    if (r.now === 'all') {
      const added = ids.filter((id) => !before.has(id));
      await updateDoc(ref, { paperIds: arrayUnion(...ids) });
      back.push(() => added.length && updateDoc(ref, { paperIds: arrayRemove(...added) }));
    } else {
      const had = ids.filter((id) => before.has(id));
      await updateDoc(ref, { paperIds: arrayRemove(...ids) });
      back.push(() => had.length && updateDoc(ref, { paperIds: arrayUnion(...had) }));
    }
  }
  const tagRows = changed.filter((x) => x.kind === 'tag');
  if (tagRows.length) {
    const olds = [];
    for (const id of ids) {
      const p = lib.papers.get(id);
      if (!p) continue;
      const old = p.tags || [];
      let next = [...old];
      for (const r of tagRows) next = r.now === 'all' ? (next.includes(r.name) ? next : [...next, r.name]) : next.filter((t) => t !== r.name);
      next = next.slice(0, 20);
      if (next.join() !== old.join()) olds.push([id, old, next]);
    }
    const write = async (pairs) => {
      for (let i = 0; i < pairs.length; i += 400) {
        const b = writeBatch(c.db);
        pairs.slice(i, i + 400).forEach(([id, tags]) => b.update(doc(c.db, 'papers', id), { tags, changedAt: serverTimestamp() }));
        await b.commit();
      }
      pairs.forEach(([id, tags]) => { const p = lib.papers.get(id); if (p) restore(id, { ...p, tags }); });
    };
    await write(olds.map(([id, , next]) => [id, next]));
    back.push(() => write(olds.map(([id, old]) => [id, old])));
  }
  return { count: changed.length, run: async () => { for (const f of back.reverse()) await f(); } };
}

// ---- Star: all selected starred -> unstar them, else star them all ----
export async function starSelected(c, ids, onChange) {
  const set = await loadStarred(c.db, c.user.uid);
  const on = !ids.every((id) => set.has(id));
  const touched = ids.filter((id) => set.has(id) !== on);
  await setStarred(c.db, c.user.uid, touched, on);
  onChange?.();
  snack(c, `${on ? 'Starred' : 'Unstarred'} ${plural(touched.length, 'paper')}`, {
    undo: async () => { await setStarred(c.db, c.user.uid, touched, !on); onChange?.(); },
  });
}

// ---- Long jobs (refresh abstracts, reindex PDFs): keep going when the sheet is hidden ----
export let job = null;
const listeners = new Set();
const tell = () => listeners.forEach((f) => f());
export const onJob = (f) => { listeners.add(f); return () => listeners.delete(f); };

const REFRESH_MISSING = ['noAbstract', 'notFound', 'noId', 'failed'];
async function runJob(kind, items, step, rows, onDone, missingKeys = REFRESH_MISSING, always = []) {
  job = { kind, always, total: items.length, done: 0, counts: Object.fromEntries(rows.map(([k]) => [k, 0])), rows, missing: [], running: true, stop: false, started: Date.now() };
  tell();
  for (const id of items) {
    if (job.stop) break;
    let out;
    try { out = await step(id); } catch (e) { console.error(e); out = 'failed'; }
    job.counts[out] = (job.counts[out] || 0) + 1;
    if (missingKeys.includes(out)) job.missing.push(id);
    job.done++;
    tell();
  }
  job.running = false;
  onDone?.();
  tell();
}

const REFRESH_ROWS = [['added', 'Abstract added', 'good'], ['updated', 'Updated', 'good'], ['unchanged', 'Already up to date', 'plain'],
  ['noAbstract', 'Found, still no abstract', 'plain'], ['notFound', 'Not found', 'warn'], ['noId', 'Skipped, no ID', 'bad']];
const FILL_ROWS = [['lookup', 'Details and abstract from a lookup', 'good'], ['pdf', 'Abstract from the PDF', 'good'], ['ai', 'Summary added', 'good'],
  ['partial', 'Details added, no abstract', 'plain'], ['nothing', 'Nothing found', 'warn'], ['noText', 'No PDF text (Reindex first)', 'bad'], ['failed', 'Could not read', 'bad']];
const REINDEX_ROWS = [['indexed', 'Indexed', 'good'], ['empty', 'No text in the PDF', 'plain'], ['failed', 'Could not read', 'bad']];

// Admin: look the selected papers up again by DOI, PubMed ID or ATOTW number; only bibliographic fields change.
export function refreshSelected(c, ids, onChange, onSelect) {
  if (job?.running) return jobSheet(c, onSelect);
  const lib = current();
  const withId = ids.filter((id) => refreshId(lib.papers.get(id) || {}));
  const noId = ids.filter((id) => !withId.includes(id));
  runJob('refresh', [...withId, ...noId], async (id) => {
    const snap = await getDoc(doc(c.db, 'papers', id));
    if (!snap.exists()) return 'notFound';
    const p = snap.data(), key = refreshId(p);
    if (!key) return 'noId';
    const r = await api(c, '/api/lookup?id=' + encodeURIComponent(key));
    if (!r.ok) return 'notFound';
    const fresh = await r.json();
    const ch = refreshChanges(p, fresh);
    if (Object.keys(ch).length) {
      await updateDoc(snap.ref, { ...ch, changedAt: serverTimestamp() });
      restore(id, cleanPaper({ ...p, ...ch }));
    }
    if (!p.abstract && ch.abstract) return 'added';
    if (!p.abstract && !fresh.abstract) return 'noAbstract';
    return Object.keys(ch).length ? 'updated' : 'unchanged';
  }, REFRESH_ROWS, () => { dirty(); onChange?.(); });
  jobSheet(c, onSelect);
}

// Admin: for papers with a PDF, the Worker reads the PDF text it already holds for search: an ID printed there is
// looked up, else the PDF's own abstract/summary is used, else a short AI summary. Only empty fields are filled;
// anything typed by hand (`manual`) is left alone. Papers with no PDF text are counted, not guessed.
export function fillSelected(c, ids, onChange, onSelect) {
  if (job?.running) return jobSheet(c, onSelect);
  const lib = current();
  const doiOwner = new Map([...lib.papers].filter(([, p]) => p.doi).map(([id, p]) => [p.doi, id]));
  runJob('fill', ids, async (id) => {
    const snap = await getDoc(doc(c.db, 'papers', id));
    if (!snap.exists()) return 'failed';
    const p = snap.data();
    if (!p.file) return 'noText';
    const r = await api(c, `/api/enrich/${id}`, { method: 'POST', body: JSON.stringify({ ai: true }), headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) return 'failed';
    const res = await r.json();
    if (!res.hasText) return 'noText';
    const taken = new Set([...doiOwner].filter(([, owner]) => owner !== id).map(([doi]) => doi));
    const ch = fillChanges(p, res, taken);
    if (!Object.keys(ch).length) return 'nothing';
    await updateDoc(snap.ref, { ...ch, changedAt: serverTimestamp() });
    restore(id, cleanPaper({ ...p, ...ch }));
    return ch.abstract ? ch.abstractSource : 'partial';
  }, FILL_ROWS, () => { dirty(); onChange?.(); }, ['nothing', 'noText', 'failed', 'partial'], ['lookup', 'pdf', 'ai', 'nothing', 'noText']);
  jobSheet(c, onSelect);
}

let indexedCache = null;
export async function indexedIds(c, fresh = false) {
  if (indexedCache && !fresh) return indexedCache;
  try {
    const r = await api(c, '/api/indexed');
    if (r.ok) indexedCache = new Set((await r.json()).ids);
  } catch { /* offline: the filter stays unknown */ }
  return indexedCache;
}
export const markIndexed = (id) => indexedCache?.add(id);

// Admin: re-extract the selected PDFs in the browser and send their text to the search index.
export function reindexSelected(c, ids, onChange, onSelect) {
  if (job?.running) return jobSheet(c, onSelect);
  const lib = current();
  runJob('reindex', ids.filter((id) => lib.papers.get(id)?.file), async (id) => {
    const r = await api(c, `/api/file/${id}`);
    if (!r.ok) return 'failed';
    const { extractPages } = await import('./pdf.js');
    const pages = await extractPages(await r.arrayBuffer());
    if (!pages.some((t) => t.trim())) return 'empty';
    const ix = await api(c, `/api/index/${id}`, { method: 'PUT', body: JSON.stringify({ pages }), headers: { 'Content-Type': 'application/json' } });
    if (!ix.ok) return 'failed';
    markIndexed(id);
    return 'indexed';
  }, REINDEX_ROWS, onChange);
  jobSheet(c, onSelect);
}

// The progress sheet; Hide leaves the job running (the library page shows a line to reopen it).
export function jobSheet(c, onSelect) {
  if (!job) return;
  const title = { refresh: 'Refreshing', fill: 'Filling', reindex: 'Reindexing' }[job.kind];
  const d = sheet(c, `${title} papers`, `<h2 class="sheet-title"></h2><p class="muted" id="jx"></p>
    <div class="progress-row"><strong id="jn"></strong><span class="muted" id="jt"></span></div>
    <div class="bar" role="progressbar" aria-label="Progress" aria-valuemin="0"><div></div></div>
    <ul class="list" id="jr"></ul><p id="jm"></p>
    <div class="sheet-buttons"><button type="button" id="jstop">Stop</button><button type="button" class="primary" id="jhide">Hide</button></div>`);
  d.querySelector('#jx').textContent = {
    refresh: 'Looks each one up by DOI, PubMed ID or ATOTW number. Only title, journal, authors and abstract change; tags, notes and PDFs never do. Keeps going if you hide this.',
    fill: 'Reads the start of each PDF for a DOI, PubMed ID or ATOTW number to look up, else uses its own abstract or summary, else writes a short abstract from the PDF text. Only empty fields are filled; anything edited by hand stays. Keeps going if you hide this.',
    reindex: 'Reads each PDF again and sends its text to PDF search. Keeps going if you hide this.',
  }[job.kind];
  const draw = () => {
    if (!d.isConnected) return off();
    d.querySelector('.sheet-title').textContent = `${job.running ? title : 'Done:'} ${plural(job.total, 'paper')}`;
    d.querySelector('#jn').textContent = `${job.done} of ${job.total}`;
    const per = job.done ? (Date.now() - job.started) / job.done : 0;
    d.querySelector('#jt').textContent = job.running && per ? `about ${Math.max(1, Math.round((per * (job.total - job.done)) / 1000))} s left` : '';
    const bar = d.querySelector('.bar');
    bar.setAttribute('aria-valuemax', job.total); bar.setAttribute('aria-valuenow', job.done);
    bar.firstChild.style.width = `${job.total ? (100 * job.done) / job.total : 100}%`;
    d.querySelector('#jr').replaceChildren(...job.rows.filter(([k]) => job.counts[k] || (job.kind === 'refresh' && ['added', 'notFound', 'noId', 'noAbstract'].includes(k)) || job.always.includes(k))
      .map(([k, label, tone]) => c.el(`<li><span class="dot-row"><span class="dot ${tone}"></span>${c.esc(label)}</span><b>${job.counts[k] || 0}</b></li>`)));
    const m = d.querySelector('#jm'); m.replaceChildren();
    if (!job.running && job.missing.length && onSelect) {
      const b = c.el(`<button type="button" class="link">Select the ${job.missing.length} still missing</button>`);
      b.onclick = () => { d.close(); onSelect(job.missing); };
      m.append(b);
    }
    d.querySelector('#jstop').hidden = !job.running;
    d.querySelector('#jhide').textContent = job.running ? 'Hide' : 'Close';
  };
  const off = onJob(draw);
  d.addEventListener('close', () => off());
  d.querySelector('#jstop').onclick = () => { job.stop = true; };
  d.querySelector('#jhide').onclick = () => d.close();
  draw();
}

// ---- More: citations, duplicates, reindex, remove ----
export function moreSheet(c, ids, acts) {
  const lib = current();
  const papers = ids.map((id) => lib.papers.get(id)).filter(Boolean);
  const admin = isAdmin(c), pdfs = papers.filter((p) => p.file).length;
  const d = sheet(c, 'More actions', `<h2 class="sheet-title">${plural(ids.length, 'paper')} selected</h2>
    <ul class="list nav-list sheet-actions">
      <li><button type="button" id="mcite">Copy citations (Vancouver)</button></li>
      <li><button type="button" id="mbib">Export BibTeX</button></li>
      ${admin ? `<li><button type="button" id="mdup">Find duplicates</button></li>
      <li><button type="button" id="mtidy">Tidy ATOTW</button></li>
      <li><button type="button" id="mfill"${pdfs ? '' : ' disabled'}>Fill missing details (${plural(pdfs, 'PDF')})</button></li>
      <li><button type="button" id="mre"${pdfs ? '' : ' disabled'}>Reindex ${plural(pdfs, 'PDF')}</button></li>
      <li><button type="button" id="mrm" class="danger">Remove ${plural(ids.length, 'paper')}</button></li>` : ''}
    </ul>`);
  d.querySelector('#mcite').onclick = () => { d.close(); citeSheet(c, vancouverList(papers)); };
  d.querySelector('#mbib').onclick = () => {
    d.close();
    const a = c.el('<a download="journalclub.bib" hidden></a>');
    a.href = URL.createObjectURL(new Blob([bibtex(papers) + '\n'], { type: 'application/x-bibtex' }));
    document.body.append(a); a.click(); a.remove();
    snack(c, `Exported ${plural(papers.length, 'citation')}`);
  };
  if (!admin) return;
  d.querySelector('#mtidy').onclick = () => { d.close(); acts.tidy(); };
  d.querySelector('#mdup').onclick = () => { d.close(); location.hash = '#/duplicates'; };
  d.querySelector('#mfill').onclick = () => { d.close(); acts.fill(); };
  d.querySelector('#mre').onclick = () => { d.close(); acts.reindex(); };
  d.querySelector('#mrm').onclick = () => { d.close(); acts.remove(); };
}

function citeSheet(c, text) {
  const d = sheet(c, 'Citations', `<h2 class="sheet-title">Citations</h2><textarea id="ctext" rows="10" readonly aria-label="Citations"></textarea>
    <div class="sheet-buttons"><button type="button" id="cclose">Close</button><button type="button" class="primary" id="ccopy">Copy</button></div>`);
  d.querySelector('#ctext').value = text;
  d.querySelector('#cclose').onclick = () => d.close();
  d.querySelector('#ccopy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch { d.querySelector('#ctext').select(); document.execCommand?.('copy'); }
    d.close(); snack(c, 'Copied');
  };
}

// Admin: removes the papers after the Undo snackbar runs out (their PDFs and search text too).
export function removeSelected(c, ids, onChange) {
  const lib = current();
  if (!confirm(`Remove ${plural(ids.length, 'paper')} and their PDFs from the library?`)) return;
  const kept = ids.map((id) => [id, lib.papers.get(id)]).filter(([, p]) => p);
  kept.forEach(([id]) => forget(id));
  onChange?.();
  snack(c, `Removed ${plural(kept.length, 'paper')}`, {
    ms: 8000,
    undo: () => { kept.forEach(([id, p]) => restore(id, p)); onChange?.(); },
    done: async () => {
      for (const [id, p] of kept) {
        try {
          if (p.file) await api(c, `/api/file/${id}`, { method: 'DELETE' });
          await api(c, `/api/index/${id}`, { method: 'DELETE' }).catch(() => {});
          await deleteDoc(doc(c.db, 'texts', id)).catch(() => {});
          await deleteDoc(doc(c.db, 'papers', id));
          const fs = await getDocs(query(collection(c.db, 'flags'), where('paperId', '==', id))).catch(() => null);
          await Promise.all((fs?.docs || []).map((f) => deleteDoc(f.ref)));
        } catch (e) { console.error('remove', id, e); restore(id, p); }
      }
    },
  });
}

// ---- Find duplicates (admin): review page with merge ----
export async function renderDuplicates(c, loadLibrary) {
  const page = c.el(`<section class="card"><p><a href="#/library">← Library</a></p><h1>Duplicates</h1>
    <p class="muted">Papers with the same DOI or nearly the same title. Merging keeps one paper with everyone's shared notes (private notes stay with their writer), the PDF, tags, reading lists and journal club sessions of both.</p>
    <p id="dmsg" class="muted" role="status">Looking…</p><div id="dl"></div></section>`);
  c.view.replaceChildren(page);
  if (!isAdmin(c)) { page.querySelector('#dmsg').textContent = 'Admins only.'; return; }
  const lib = await loadLibrary();
  const groups = findDuplicates([...lib.papers]);
  const msg = page.querySelector('#dmsg'), box = page.querySelector('#dl');
  msg.textContent = groups.length ? `${plural(groups.length, 'group')} found.` : 'No duplicates found.';
  for (const g of groups) {
    const [keep0, drop0] = pickKeep([g.ids[0], lib.papers.get(g.ids[0])], [g.ids[1], lib.papers.get(g.ids[1])]);
    let keep = keep0[0];
    const two = [keep0, drop0];
    const card = c.el(`<div class="dup"><h2>${c.esc(g.reason)}${g.ids.length > 2 ? ` <span class="muted">· ${g.ids.length} papers, merged two at a time</span>` : ''}</h2>
      <ul class="list"></ul><p><button type="button" class="primary">Merge</button> <span class="muted" role="status"></span></p></div>`);
    const ul = card.querySelector('ul');
    two.forEach(([id, p]) => {
      const li = c.el(`<li><label class="check-row"><input type="radio" name="k-${c.esc(g.ids.join('-'))}" value="${c.esc(id)}"><span class="grow"><a href="#/paper/${c.esc(id)}"></a><br>
        <span class="muted"></span></span></label></li>`);
      li.querySelector('a').textContent = p.title;
      li.querySelector('.muted').textContent = [[p.journal, p.year].filter(Boolean).join(' '), p.doi && `DOI ${p.doi}`, p.file ? 'PDF' : 'no PDF',
        p.abstract ? 'abstract' : 'no abstract', (p.presented || []).length && 'presented'].filter(Boolean).join(' · ');
      const r = li.querySelector('input');
      r.checked = id === keep;
      r.disabled = !keepAllowed(p, two.find(([o]) => o !== id)[1]);
      r.setAttribute('aria-label', `Keep ${p.title}`);
      r.onchange = () => { keep = id; };
      ul.append(li);
    });
    const btn = card.querySelector('button'), out = card.querySelector('[role=status]');
    btn.onclick = async () => {
      const drop = two.find(([id]) => id !== keep)[0];
      if (!confirm('Merge these two papers into the ticked one? The other is removed.')) return;
      btn.disabled = true; out.textContent = 'Merging…';
      try { await mergePapers(c, keep, drop); renderDuplicates(c, loadLibrary); } catch (e) { console.error(e); out.textContent = `Stopped: ${e.message || e}`; btn.disabled = false; }
    };
    box.append(card);
  }
}

export async function mergePapers(c, keepId, dropId) {
  const [ks, ds] = await Promise.all([getDoc(doc(c.db, 'papers', keepId)), getDoc(doc(c.db, 'papers', dropId))]);
  if (!ks.exists() || !ds.exists()) throw new Error('one of the papers is gone');
  const K = ks.data(), D = ds.data();
  if (!keepAllowed(K, D)) throw new Error('keep the paper with the PDF');
  const m = mergePaper(K, D);
  const now = { changedAt: serverTimestamp() };
  if (Object.keys(m.edit).length) await updateDoc(ks.ref, { ...m.edit, ...now });
  if (m.presented) await updateDoc(ks.ref, { presented: m.presented, ...now });
  if (Object.keys(m.biblio).length) await updateDoc(ks.ref, { ...m.biblio, ...now });
  // Only shared notes are readable here; a member's private note is never read or moved. A shared note moves unless the
  // member already has a private note on the kept paper (the write is refused), and then it stays where it is.
  const shared = (pid) => getDocs(query(collection(c.db, 'papers', pid, 'notes'), where('shared', '==', true)));
  const [kn, dn] = await Promise.all([shared(keepId), shared(dropId)]);
  const notes = mergeNotes(kn.docs.map((d) => ({ uid: d.id, ...d.data() })), dn.docs.map((d) => ({ uid: d.id, ...d.data() })));
  const stuck = new Set();
  for (const n of notes) {
    await setDoc(doc(c.db, 'papers', keepId, 'notes', n.uid), { text: n.text || '', rating: n.rating || 0,
      ...(n.name ? { name: n.name } : {}), shared: true, updatedAt: n.updatedAt || serverTimestamp() }).catch(() => stuck.add(n.uid));
  }
  await Promise.all(dn.docs.filter((d) => !stuck.has(d.id)).map((d) => deleteDoc(d.ref)));
  const ls = await getDocs(query(collection(c.db, 'lists'), where('paperIds', 'array-contains', dropId)));
  for (const l of ls.docs) {
    const ids = [...new Set(l.data().paperIds.map((id) => (id === dropId ? keepId : id)))];
    await updateDoc(l.ref, { paperIds: ids });
  }
  const ss = await getDocs(query(collection(c.db, 'sessions'), where('paperId', '==', dropId)));
  for (const s of ss.docs) await updateDoc(s.ref, { paperId: keepId, paperTitle: K.title });
  if (D.file) await api(c, `/api/file/${dropId}`, { method: 'DELETE' });
  await api(c, `/api/index/${dropId}`, { method: 'DELETE' }).catch(() => {});
  await deleteDoc(doc(c.db, 'texts', dropId)).catch(() => {});
  await deleteDoc(ds.ref);
  const fs = await getDocs(query(collection(c.db, 'flags'), where('paperId', '==', dropId))).catch(() => null);
  await Promise.all((fs?.docs || []).map((f) => deleteDoc(f.ref)));
  await api(c, `/api/index/${keepId}/notes`, { method: 'POST' }).catch(() => {});
  forget(dropId); dirty();
}
