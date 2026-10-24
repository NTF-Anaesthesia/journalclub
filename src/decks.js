// Slides: teaching decks (decks/<id>, any member adds one) and the slides of past sessions, shown together on the
// Library's Slides side. A deck's page is #/deck/<id> (#/deck/new, #/deck/<id>/edit); slides open in the reader at
// #/view/deck_<id>/<page> or #/view/sess_<session>/<page>. Slide text is searched by the Worker under those keys.
import {
  doc, getDoc, getDocs, collection, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { decodeEntities } from './abstract.js';

export const DECK_ROUTES = ['deck', 'view'];

let c;
const MAX_SLIDES = 50 * 1024 * 1024;
const SLIDE_TYPES = '.pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation';
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/.test(u || '') ? u : '');
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const SLIDE_KEY = /^(deck|sess)_/;

async function apiFetch(path, init = {}) {
  const token = await c.user.getIdToken();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}

export function renderDeckRoute(r, ctx) {
  c = ctx;
  if (r.name === 'view' && r.arg) return import('./reader.js').then((m) => m.renderReader(r, c, apiFetch));
  if (r.arg === 'new') return renderForm(null);
  if (r.arg && r.arg2 === 'edit') return renderForm(r.arg);
  if (r.arg) return renderDeck(r.arg);
  location.hash = '#/library/slides';
}

// ---- The Slides list: decks and session slides as one kind of item ----

// { key, kind, id, title, by, date (ms or null), tags, about, pdf, url, href }: href is the slide page.
export function deckItem(id, d) {
  return { key: `deck_${id}`, kind: 'deck', id, title: d.title || 'Untitled deck', by: d.by || '', date: d.date?.toMillis?.() ?? null,
    tags: d.tags || [], about: d.about || '', pdf: !!d.slidesFile?.pdf, original: !!d.slidesFile?.kind && d.slidesFile.kind !== 'pdf',
    url: '', href: `#/deck/${id}` };
}
export function sessionItem(id, s) {
  const pdf = !!s.slidesFile?.pdf, url = pdf ? '' : safeUrl(s.slides);
  if (!pdf && !url && !s.slidesFile?.kind) return null;
  return { key: `sess_${id}`, kind: 'session', id, title: decodeEntities(s.paperTitle || 'Session'), by: s.presenterName || '',
    date: s.date?.toMillis?.() ?? null, tags: [], about: '', pdf, original: !!s.slidesFile?.kind && s.slidesFile.kind !== 'pdf', url, href: `#/session/${id}` };
}

// Decks and sessions are few next to papers: read once, kept two minutes (dirty() after a change).
let cache = null;
export const dirtySlides = () => { cache = null; };
export function loadSlideItems(db) {
  if (!cache || Date.now() - cache.at > 120000) {
    const p = Promise.all([getDocs(collection(db, 'decks')), getDocs(collection(db, 'sessions'))]).then(([ds, ss]) => {
      const items = [...ds.docs.map((d) => deckItem(d.id, d.data())), ...ss.docs.map((d) => sessionItem(d.id, d.data())).filter(Boolean)];
      return items.sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || a.title.localeCompare(b.title));
    }, (e) => { cache = null; throw e; });
    cache = { at: Date.now(), p };
  }
  return cache.p;
}

const words = (q) => (String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 || /\d/.test(w));
// Every word of the box starts a word of the item's title, presenter, tags or description.
export function metaMatch(item, q) {
  const ws = words(q.replace(/-"[^"]*"|-\S+/g, ' '));
  if (!ws.length) return false;
  const hay = words(`${item.title} ${item.by} ${item.tags.join(' ')} ${item.about}`);
  return ws.every((w) => hay.some((h) => h.startsWith(w)));
}

// Metadata hits first (newest first), taking the Worker's slide and snippet when it found them too; then slides
// found only in their text. `server` hits are the Worker's, keyed deck_<id> / sess_<id>.
export function matchSlides(items, q, server = []) {
  const byKey = new Map(server.filter((h) => SLIDE_KEY.test(h.paperId)).map((h) => [h.paperId, h]));
  const meta = items.filter((it) => metaMatch(it, q));
  const seen = new Set(meta.map((it) => it.key));
  const out = meta.map((it) => ({ item: it, page: byKey.get(it.key)?.page || null, snippet: byKey.get(it.key)?.snippet || null }));
  for (const it of items) {
    const h = byKey.get(it.key);
    if (h && !seen.has(it.key)) out.push({ item: it, page: h.page || null, snippet: h.snippet || null });
  }
  return out;
}

const SLIDES_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/></svg>';
const snippetHtml = (s) => c.esc(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');

// A card: a slide text hit opens the reader at that slide; otherwise the deck's or session's page.
export function slideRow(ctx, { item, page, snippet }, q = '') {
  c = ctx;
  const href = page && item.pdf ? `#/view/${item.key}/${page}${q ? '?q=' + encodeURIComponent(q) : ''}` : item.href;
  const meta = [item.kind === 'deck' ? 'Teaching' : 'Session slides', item.by, item.date ? fmtDate(new Date(item.date)) : ''].filter(Boolean).join(' · ');
  const open = item.pdf ? `<a class="pdf-pill" href="#/view/${item.key}" aria-label="Open the slides">${SLIDES_ICON}Slides</a>`
    : item.url ? `<a class="pdf-pill" href="${c.esc(item.url)}" target="_blank" rel="noopener" aria-label="Open the slides">${SLIDES_ICON}Link</a>` : '';
  const tags = item.tags.map((t) => `<span class="tag">${c.esc(t)}</span>`).join('');
  return c.el(`<li class="paper slide-row" data-key="${c.esc(item.key)}"><a href="${href}">${c.esc(item.title)}</a>
    <span class="muted">${c.esc(meta)}${page ? ` <span class="hit">slide ${page}</span>` : ''}</span>
    ${snippet ? `<span class="snippet muted">${snippetHtml(snippet)}</span>` : ''}${open || tags ? `<span class="pills">${open}${tags}</span>` : ''}</li>`);
}

// The Library's Slides side (#/library/slides?q=): the same search box; `search(q)` is the Worker search, `setQ` keeps
// the box text shared with the Journals side.
export async function renderSlides(ctx, { q: q0, search, setQ, seg }) {
  c = ctx;
  const admin = c.member.role === 'admin';
  const page = c.el(`<section class="card lib"><h1>Library</h1>${seg}
    <form id="sf" role="search" class="searchbox"><input id="q" type="search" aria-label="Search the library"
      placeholder="Search papers and slides" autocomplete="off" enterkeyhint="search"></form>
    <p class="actions"><a class="button primary" href="#/deck/new">Add a teaching deck</a></p>
    <p id="jlink" class="muted" hidden></p>
    <p id="count" class="count" aria-live="polite">Loading…</p><ul id="sres" class="list"></ul>
    ${admin ? '<p id="six" class="muted"></p>' : ''}</section>`);
  c.view.replaceChildren(page);
  const box = page.querySelector('#q'), res = page.querySelector('#sres'), count = page.querySelector('#count');
  box.value = q0 || '';
  let items;
  try { items = await loadSlideItems(c.db); } catch { count.textContent = 'Could not load the slides. Check your connection.'; return; }
  if (!page.isConnected) return;
  let seq = 0, timer = null;
  const draw = (hits, done) => {
    res.replaceChildren(...hits.map((h) => slideRow(c, h, box.value.trim())));
    const n = hits.length;
    count.textContent = box.value.trim()
      ? (n ? `${n} found${done ? '' : ', searching slide text…'}` : done ? 'Nothing found.' : 'Searching slide text…')
      : `${items.length} ${items.length === 1 ? 'deck' : 'decks'}`;
    if (!items.length) res.append(c.el('<li class="muted">No slides yet. Add a teaching deck, or add slides to a session.</li>'));
  };
  const jl = page.querySelector('#jlink');
  const show = () => {
    const q = box.value.trim();
    setQ(q);
    const mine = ++seq;
    clearTimeout(timer);
    jl.hidden = !q;
    if (q) { jl.replaceChildren(c.el(`<a href="#/library?q=${encodeURIComponent(q)}">Search papers for “${c.esc(q)}”</a>`)); }
    if (!q) { draw(items.map((item) => ({ item })), true); return; }
    draw(matchSlides(items, q), words(q).join('').length < 3);
    if (words(q).join('').length < 3) return;
    timer = setTimeout(async () => {
      const server = await search(q);
      if (mine !== seq || !page.isConnected) return;
      draw(matchSlides(items, q, server.hits), true);
    }, 250);
  };
  box.addEventListener('input', show);
  page.querySelector('#sf').onsubmit = (e) => { e.preventDefault(); box.blur(); };
  show();
  if (admin) adminIndex(page.querySelector('#six'), items);
}

// Admin: slides with a PDF whose text is not in the search index yet (older session slides) get indexed here.
async function adminIndex(p, items) {
  const r = await apiFetch('/api/indexed').catch(() => null);
  if (!r?.ok || !p.isConnected) return;
  const have = new Set((await r.json()).ids || []);
  const todo = items.filter((it) => it.pdf && !have.has(it.key));
  if (!todo.length) { p.textContent = 'All slide text is searchable.'; return; }
  const b = c.el(`<button type="button" class="link">Make ${todo.length} ${todo.length === 1 ? 'deck' : 'decks'} searchable</button>`);
  b.onclick = async () => {
    b.disabled = true;
    let done = 0, failed = 0;
    for (const it of todo) {
      p.firstChild.textContent = `Indexing ${done + failed + 1} of ${todo.length}…`;
      if (await indexSlideText(it.kind === 'deck' ? 'decks' : 'slides', it.id)) done++; else failed++;
    }
    p.replaceChildren(`${done} indexed${failed ? `, ${failed} could not be read` : ''}.`);
  };
  p.replaceChildren(document.createTextNode(''), b);
}

// Reads the slides' PDF back from the Worker, takes its text per slide and stores it for search. True when stored.
export async function indexSlideText(kind, id, ctx = c, fetchFn = null) {
  c = ctx;
  const f = fetchFn || apiFetch;
  try {
    const r = await f(`/api/${kind}/${id}/pdf`);
    if (!r.ok) return false;
    const { extractPages } = await import('./pdf.js');
    const pages = await extractPages(await r.arrayBuffer());
    const ix = await f(`/api/${kind}/${id}/text`, { method: 'PUT', body: JSON.stringify({ pages }), headers: { 'Content-Type': 'application/json' } });
    return ix.ok;
  } catch { return false; }
}

// The Journals side's search shows matching slides above the papers: the first three, then a link to the rest.
export async function drawSlideGroup(ctx, host, q, server = []) {
  c = ctx;
  if (!q) { host.hidden = true; host.replaceChildren(); return; }
  const items = await loadSlideItems(c.db).catch(() => []);
  const hits = matchSlides(items, q, server);
  if (!host.isConnected) return;
  host.hidden = !hits.length;
  if (!hits.length) { host.replaceChildren(); return; }
  host.replaceChildren(c.el(`<h2 class="group-h">Slides</h2>`), c.el('<ul class="list"></ul>'));
  host.querySelector('ul').append(...hits.slice(0, 3).map((h) => slideRow(c, h, q)));
  host.append(c.el(`<p class="more"><a href="#/library/slides?q=${encodeURIComponent(q)}">${hits.length > 3 ? `All ${hits.length} slides` : 'Open in Slides'}</a></p>`));
  host.append(c.el('<h2 class="group-h">Papers</h2>'));
}

// ---- A deck's page and its form ----

const mayEdit = (d) => c.member.role === 'admin' || d.createdBy === c.user.uid;

async function renderDeck(id) {
  const view = c.view;
  const snap = await getDoc(doc(c.db, 'decks', id)).catch(() => null);
  if (!snap?.exists()) { view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/library/slides">Slides</a></p></section>')); return; }
  const d = snap.data(), it = deckItem(id, d), sf = d.slidesFile?.kind ? d.slidesFile : null;
  document.title = `${it.title} · Journal club`;
  const meta = [it.by, it.date ? fmtDate(new Date(it.date)) : ''].filter(Boolean).join(' · ');
  const page = c.el(`<section class="card deckpage"><p class="eyebrow">TEACHING SLIDES</p><p class="back"><a href="#/library/slides">← Slides</a></p>
    <h1>${c.esc(it.title)}</h1>${meta ? `<p class="muted">${c.esc(meta)}</p>` : ''}
    ${it.tags.length ? `<p class="pills">${it.tags.map((t) => `<span class="tag">${c.esc(t)}</span>`).join('')}</p>` : ''}
    ${it.about ? `<p class="about">${c.esc(it.about)}</p>` : ''}
    <p class="actions">${it.pdf ? `<a class="button primary" href="#/view/${it.key}">Open slides</a>` : ''}
      ${it.original ? '<button type="button" id="dorig">Download PowerPoint</button>' : ''}</p>
    <p class="muted">${sf ? `${c.esc(sf.name || '')} · ${fmtSize(sf.size || 0)}${sf.kind !== 'pdf' && !sf.pdf ? ' · no PDF copy yet' : ''}` : 'No file yet.'}</p>
    ${mayEdit(d) ? `<p class="actions"><a href="#/deck/${c.esc(id)}/edit">Edit deck</a></p>` : ''}</section>`);
  view.replaceChildren(page);
  const o = page.querySelector('#dorig');
  if (o) o.onclick = async () => {
    const r = await apiFetch(`/api/decks/${id}/original`).catch(() => null);
    if (!r?.ok) { alert('Could not download the slides.'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: sf?.name || 'slides.pptx' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
}

async function renderForm(id) {
  const view = c.view;
  const snap = id ? await getDoc(doc(c.db, 'decks', id)).catch(() => null) : null;
  if (id && !snap?.exists()) { view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/library/slides">Slides</a></p></section>')); return; }
  const d = snap?.data() || null;
  if (d && !mayEdit(d)) {
    view.replaceChildren(c.el(`<section class="card"><h1>Not allowed</h1><p>Only the person who added this deck, or an admin, can change it.</p><p><a href="#/deck/${c.esc(id)}">Back to the deck</a></p></section>`));
    return;
  }
  const sf = d?.slidesFile?.kind ? d.slidesFile : null;
  const page = c.el(`<section class="card"><p><a href="${id ? `#/deck/${c.esc(id)}` : '#/library/slides'}">← ${id ? 'Back to the deck' : 'Slides'}</a></p>
    <h1>${id ? 'Edit deck' : 'Add a teaching deck'}</h1>
    <form id="df" class="stack">
      <label>Title <input id="dtitle" required maxlength="300" placeholder="e.g. Difficult airway: a practical approach"></label>
      <label>Presenter or author <input id="dby" maxlength="120"></label>
      <label>Date given (optional) <input id="ddate" type="date"></label>
      <label>Topics (optional, comma separated) <input id="dtags" maxlength="400" placeholder="airway, obstetrics"></label>
      <label>About (optional) <textarea id="dabout" rows="3" maxlength="4000"></textarea></label>
      <h2>File</h2><p class="muted" id="dcur">${sf ? `${c.esc(sf.name || '')} · ${fmtSize(sf.size || 0)}` : 'No file yet.'}</p>
      <label>${sf ? 'Replace with' : 'Upload'} slides (PDF or PowerPoint, up to 50 MB) <input type="file" id="dfile" accept="${SLIDE_TYPES}"></label>
      <label>Or pull from a link <input id="durl" type="url" placeholder="Google Slides, OneDrive, Dropbox or Drive link"></label>
      <p class="muted">A link works only if it is shared as "Anyone with the link can view"; the file is copied here. PowerPoint is also saved as a PDF, and the slide text becomes searchable.</p>
      <button class="primary" id="dsave">${id ? 'Save' : 'Add deck'}</button>
      <p id="dmsg" class="muted" role="status"></p></form>
    ${id ? '<p><button type="button" class="link danger" id="ddel">Delete deck</button></p>' : ''}</section>`);
  view.replaceChildren(page);
  const $ = (s) => page.querySelector(s);
  $('#dtitle').value = d?.title || '';
  $('#dby').value = d ? d.by || '' : c.member.name || c.user.displayName || '';
  $('#ddate').value = d?.date ? isoDay(d.date.toDate()) : '';
  $('#dtags').value = (d?.tags || []).join(', ');
  $('#dabout').value = d?.about || '';
  const msg = $('#dmsg'), btn = $('#dsave');
  $('#df').onsubmit = async (e) => {
    e.preventDefault();
    const file = $('#dfile').files[0], link = $('#durl').value.trim();
    if (!id && !file && !link) { msg.textContent = 'Choose a file or paste a link.'; return; }
    if (file && file.size > MAX_SLIDES) { msg.textContent = 'Slides are over 50 MB.'; return; }
    if (!file && link && !safeUrl(link)) { msg.textContent = 'The link must start with https://'; return; }
    const tags = [...new Set($('#dtags').value.split(',').map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
    const dv = $('#ddate').value;
    const fields = { title: $('#dtitle').value.trim(), by: $('#dby').value.trim(), about: $('#dabout').value.trim(), tags,
      date: dv ? Timestamp.fromDate(new Date(`${dv}T12:00:00`)) : null, changedAt: serverTimestamp() };
    btn.disabled = true;
    let did = id;
    try {
      if (id) await updateDoc(doc(c.db, 'decks', id), fields);
      else did = (await addDoc(collection(c.db, 'decks'), { ...fields, slidesFile: {}, createdBy: c.user.uid, createdAt: serverTimestamp() })).id;
    } catch { msg.textContent = 'Could not save the deck.'; btn.disabled = false; return; }
    dirtySlides();
    if (file || link) {
      msg.textContent = file ? 'Uploading… a PowerPoint takes up to a minute to turn into a PDF.' : 'Pulling the slides from the link…';
      const r = await (file
        ? apiFetch(`/api/decks/${did}`, { method: 'PUT', body: file, headers: { 'X-File-Name': encodeURIComponent(file.name) } })
        : apiFetch(`/api/decks/${did}`, { method: 'POST', body: JSON.stringify({ url: link }), headers: { 'Content-Type': 'application/json' } })).catch(() => null);
      const out = await r?.json().catch(() => ({})) || {};
      if (!r?.ok) {
        msg.textContent = `${out.error || 'Could not save the slides.'} The deck is saved: try the file again here.`;
        btn.disabled = false;
        if (!id) location.hash = `#/deck/${did}/edit`;
        return;
      }
      await updateDoc(doc(c.db, 'decks', did), { slidesFile: { name: out.name, size: out.size, kind: out.kind, pdf: out.pdf }, changedAt: serverTimestamp() });
      if (out.warning) alert(out.warning);
      if (out.pdf) { msg.textContent = 'Making the slide text searchable…'; await indexSlideText('decks', did); }
      dirtySlides();
    }
    location.hash = `#/deck/${did}`;
  };
  if (id) $('#ddel').onclick = async () => {
    if (!confirm('Delete this deck and its file?')) return;
    const r = await apiFetch(`/api/decks/${id}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { msg.textContent = 'Could not delete the file.'; return; }
    await deleteDoc(doc(c.db, 'decks', id));
    dirtySlides();
    location.hash = '#/library/slides';
  };
}
