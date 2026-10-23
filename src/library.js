// Library pages: search, add by DOI or PubMed ID, bulk PDF import, paper page (notes, ratings, PDF), reading lists.
import {
  doc, getDoc, getDocs, collection, collectionGroup, setDoc, addDoc, deleteDoc, updateDoc, query, where,
  serverTimestamp, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { buildIndex, searchPapers } from './search.js';
import { findDoi } from './doi.js';
import { abstractSections } from './abstract.js';

export const LIBRARY_ROUTES = ['library', 'add', 'import', 'paper', 'remove', 'lists', 'list'];
const NUS_PROXY = 'https://libproxy1.nus.edu.sg/login?url=';

let c;              // { db, user, member, view, el, esc } for the current render
let lib = null;     // cached { papers, notes, texts, index }
let lastQuery = '';

const $in = (root, sel) => root.querySelector(sel);
const mayEdit = (p) => c.member.role === 'admin' || p.addedBy === c.user.uid;
const authorLine = (a = []) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '));
const tagList = (s) => [...new Set(String(s).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);

async function apiFetch(path, init = {}) {
  const token = await c.user.getIdToken();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}

async function loadLibrary() {
  if (lib) return lib;
  const [ps, ns, ts] = await Promise.all([
    getDocs(collection(c.db, 'papers')), getDocs(collectionGroup(c.db, 'notes')), getDocs(collection(c.db, 'texts')),
  ]);
  const papers = new Map(ps.docs.map((d) => [d.id, d.data()]));
  const notes = new Map();
  ns.forEach((d) => { const pid = d.ref.parent.parent.id; notes.set(pid, [...(notes.get(pid) || []), d.data()]); });
  const texts = new Map(ts.docs.map((d) => [d.id, d.data().pages || []]));
  lib = { papers, notes, texts, index: buildIndex(papers, notes, texts) };
  return lib;
}
const dirty = () => { lib = null; };

export function renderLibraryRoute(r, ctx) {
  c = ctx;
  if (r.name === 'add') return renderAdd();
  if (r.name === 'import') return renderImport();
  if (r.name === 'paper' && r.arg) return renderPaper(r.arg, Number(r.arg2) || null);
  if (r.name === 'remove' && r.arg) return renderRemove(r.arg);
  if (r.name === 'lists') return renderLists();
  if (r.name === 'list' && r.arg) return renderList(r.arg);
  return renderSearch();
}

function paperItem(id, p, page) {
  const meta = [p.journal, p.year].filter(Boolean).join(' ');
  const tags = (p.tags || []).map((t) => `<span class="tag">${c.esc(t)}</span>`).join(' ');
  const hit = page ? ` <span class="hit">p. ${page}</span>` : '';
  const pdf = p.file ? ' <span class="muted">PDF</span>' : '';
  return c.el(`<li class="paper"><a href="#/paper/${id}${page ? '/' + page : ''}">${c.esc(p.title)}</a>
    <span class="muted">${c.esc(meta)}${pdf}${hit}</span><span>${tags}</span></li>`);
}

async function renderSearch() {
  const page = c.el(`<section class="card"><h1>Library</h1>
    <form id="sf" role="search" class="row"><input id="q" type="search" aria-label="Search the library"
      placeholder="Search titles, tags, notes and PDFs" autocomplete="off"></form>
    <p class="actions"><a class="button primary" href="#/add">Add a paper</a> <a href="#/import">Import PDFs</a> <a href="#/lists">Reading lists</a></p>
    <p id="count" class="muted">Loading…</p><ul id="res" class="list"></ul></section>`);
  c.view.replaceChildren(page);
  const q = $in(page, '#q');
  q.value = lastQuery;
  const { papers, index } = await loadLibrary();
  const show = () => {
    lastQuery = q.value.trim();
    const res = $in(page, '#res');
    res.replaceChildren();
    if (!lastQuery) {
      const all = [...papers].sort((a, b) => (b[1].addedAt?.seconds || 0) - (a[1].addedAt?.seconds || 0));
      all.forEach(([id, p]) => res.append(paperItem(id, p)));
      $in(page, '#count').textContent = all.length ? `${all.length} papers, newest first` : 'No papers yet. Add the first one.';
      return;
    }
    const hits = searchPapers(index, lastQuery).filter((h) => papers.has(h.paperId));
    hits.forEach((h) => res.append(paperItem(h.paperId, papers.get(h.paperId), h.page)));
    $in(page, '#count').textContent = hits.length ? `${hits.length} found` : 'Nothing found.';
  };
  q.oninput = show;
  $in(page, '#sf').onsubmit = (e) => { e.preventDefault(); q.blur(); };
  show();
}

async function renderAdd() {
  const page = c.el(`<section class="card"><h1>Add a paper</h1>
    <form id="lf" class="row"><input id="pid" aria-label="DOI or PubMed ID" placeholder="DOI or PubMed ID" required>
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
    tags, why, addedBy: c.user.uid, addedAt: serverTimestamp(),
  });
}

// Stores the PDF and its per-page text for search. Returns null on success, else the reason.
async function storePdf(id, buf, pages) {
  const r = await apiFetch(`/api/file/${id}`, { method: 'PUT', body: buf, headers: { 'Content-Type': 'application/pdf' } });
  if (!r.ok) return (await r.json().catch(() => ({}))).error || 'Upload refused.';
  await setDoc(doc(c.db, 'texts', id), { pages });
  await updateDoc(doc(c.db, 'papers', id), { file: { pages: pages.length, size: buf.byteLength } });
  return null;
}

const MAX_PDF = 25 * 1024 * 1024;
const fileTitle = (name) => name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled PDF';

async function renderImport() {
  const page = c.el(`<section class="card"><p><a href="#/library">← Library</a></p><h1>Import PDFs</h1>
    <p class="muted">Choose PDFs or a whole folder. Each paper's DOI is read from its first pages and the details filled in;
      PDFs without a DOI are added under their file name. Papers already in the library are skipped.</p>
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
        const found = findDoi(pages.slice(0, 2).join(' '));
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

async function openPdf(id, page) {
  const w = window.open('', '_blank'); // opened before the await so pop-up blockers allow it
  const r = await apiFetch(`/api/file/${id}`);
  if (!r.ok) { w?.close(); alert('Could not open the PDF.'); return; }
  const url = URL.createObjectURL(await r.blob()) + (page ? `#page=${page}` : '');
  if (w) w.location.href = url; else location.href = url;
}

async function renderPaper(id, hitPage) {
  const snap = await getDoc(doc(c.db, 'papers', id));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/library">Library</a></p></section>')); return; }
  const p = snap.data();
  const [ns, ls] = await Promise.all([getDocs(collection(c.db, 'papers', id, 'notes')), getDocs(collection(c.db, 'lists'))]);
  const notes = ns.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const mine = notes.find((n) => n.uid === c.user.uid);
  const rated = notes.filter((n) => n.rating > 0);
  const avg = rated.length ? (rated.reduce((s, n) => s + n.rating, 0) / rated.length).toFixed(1) : null;
  const links = [
    p.doi && `<a href="https://doi.org/${c.esc(p.doi)}" target="_blank" rel="noopener">Publisher page</a>`,
    p.doi && `<a href="${NUS_PROXY}${encodeURIComponent('https://doi.org/' + p.doi)}" target="_blank" rel="noopener">Via NUS Libraries</a>`,
    p.pmid && `<a href="https://pubmed.ncbi.nlm.nih.gov/${c.esc(p.pmid)}/" target="_blank" rel="noopener">PubMed</a>`,
  ].filter(Boolean).join(' · ');
  const page = c.el(`<section class="card"><p><a href="#/library">← Library</a></p><h1>${c.esc(p.title)}</h1>
    <p class="muted">${c.esc(authorLine(p.authors))}<br>${c.esc([p.journal, p.year].filter(Boolean).join(' '))}</p>
    <p>${links}</p>
    <p>${(p.tags || []).map((t) => `<span class="tag">${c.esc(t)}</span>`).join(' ')}</p>
    ${p.why ? `<p><strong>Why read it:</strong> ${c.esc(p.why)}</p>` : ''}
    ${p.abstract ? `<details><summary>Abstract</summary><div class="abstract">${abstractSections(p.abstract)
      .map((x) => `<p>${x.label ? `<strong>${c.esc(x.label)}:</strong> ` : ''}${c.esc(x.text)}</p>`).join('')}</div></details>` : ''}
    <h2>PDF</h2><div id="file"></div>
    <h2>Notes and ratings ${avg ? `<span class="muted">· ${avg}/5 from ${rated.length}</span>` : ''}</h2>
    <form id="nf" class="stack"><label>Your note <textarea id="note" rows="3" maxlength="4000"></textarea></label>
      <label>Your rating <select id="rating"><option value="0">No rating</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n} / 5</option>`).join('')}</select></label>
      <button class="primary">Save note</button></form>
    <ul id="notes" class="list"></ul>
    <h2>Reading lists</h2><form id="rl" class="row"><select id="lsel" aria-label="Reading list"></select><button>Add to list</button></form>
    <div id="edit"></div></section>`);
  c.view.replaceChildren(page);

  // PDF: open, or upload.
  const file = $in(page, '#file');
  if (p.file) {
    const open = c.el(`<button class="primary">Open PDF${hitPage ? ` at page ${hitPage}` : ''}</button>`);
    open.onclick = () => openPdf(id, hitPage);
    file.append(open, c.el(`<span class="muted"> ${p.file.pages} pages</span>`));
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
  if (mine) { $in(page, '#note').value = mine.text; $in(page, '#rating').value = String(mine.rating || 0); }
  const nl = $in(page, '#notes');
  notes.filter((n) => n.text || n.rating).forEach((n) => nl.append(c.el(`<li><span><strong>${c.esc(n.name || 'Member')}</strong>
    ${n.rating ? `<span class="muted">${n.rating}/5</span>` : ''}<br>${c.esc(n.text)}</span></li>`)));
  $in(page, '#nf').onsubmit = async (e) => {
    e.preventDefault();
    await setDoc(doc(c.db, 'papers', id, 'notes', c.user.uid), {
      text: $in(page, '#note').value.trim(), rating: Number($in(page, '#rating').value),
      name: c.member.name || c.user.displayName || c.user.email, updatedAt: serverTimestamp(),
    });
    dirty(); renderPaper(id, hitPage);
  };

  // Reading lists this member may edit.
  const editable = ls.docs.filter((d) => c.member.role === 'admin' || d.data().createdBy === c.user.uid);
  const sel = $in(page, '#lsel');
  if (!editable.length) $in(page, '#rl').replaceChildren(c.el('<p class="muted">No lists of yours yet. <a href="#/lists">Make one</a>.</p>'));
  editable.forEach((d) => sel.append(c.el(`<option value="${d.id}">${c.esc(d.data().name)}${d.data().paperIds.includes(id) ? ' (added)' : ''}</option>`)));
  $in(page, '#rl').onsubmit = async (e) => {
    e.preventDefault();
    await updateDoc(doc(c.db, 'lists', sel.value), { paperIds: arrayUnion(id) });
    location.hash = `#/list/${sel.value}`;
  };

  // Tags and why: the adder or an admin, who also get a link to the separate removal page.
  if (mayEdit(p)) {
    const ed = c.el(`<details><summary>Edit</summary><form id="ef" class="stack">
      <label>Tags <input id="etags"></label><label>Why read it <input id="ewhy" maxlength="200"></label>
      <button class="primary">Save</button></form>
      <p class="muted"><a href="#/remove/${c.esc(id)}">Remove this paper or its PDF…</a></p></details>`);
    $in(ed, '#etags').value = (p.tags || []).join(', ');
    $in(ed, '#ewhy').value = p.why || '';
    $in(ed, '#ef').onsubmit = async (e) => {
      e.preventDefault();
      await updateDoc(doc(c.db, 'papers', id), { tags: tagList($in(ed, '#etags').value), why: $in(ed, '#ewhy').value.trim() });
      dirty(); renderPaper(id, hitPage);
    };
    $in(page, '#edit').append(ed);
  }

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
  const p = snap.data();
  if (!mayEdit(p)) { c.view.replaceChildren(c.el(`<section class="card"><h1>Not allowed</h1><p>Only the person who added this paper, or an admin, can remove it.</p><p><a href="#/paper/${c.esc(id)}">Back to the paper</a></p></section>`)); return; }
  const page = c.el(`<section class="card"><p><a href="#/paper/${c.esc(id)}">← Back to the paper</a></p><h1>Remove</h1>
    <p><strong>${c.esc(p.title)}</strong></p>
    ${p.file ? '<h2>Remove the PDF only</h2><p class="muted">The paper stays in the library; the stored file and its search text go.</p><button id="rpdf" class="danger-btn">Remove PDF</button>' : ''}
    <h2>Remove the whole paper</h2>
    <p class="muted">This also removes its PDF. Notes, ratings and votes on it are no longer reachable. Type the title to confirm.</p>
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
        await apiFetch(`/api/file/${id}`, { method: 'DELETE' });
        await deleteDoc(doc(c.db, 'texts', id));
        await updateDoc(doc(c.db, 'papers', id), { file: null });
        await clearFlags();
        dirty(); location.hash = `#/paper/${id}`;
      } catch { msg.textContent = 'Could not remove the PDF.'; }
    };
  }
  $in(page, '#rf').onsubmit = async (e) => {
    e.preventDefault();
    if (norm($in(page, '#rtitle').value) !== norm(p.title)) return;
    try {
      if (p.file) { await apiFetch(`/api/file/${id}`, { method: 'DELETE' }); await deleteDoc(doc(c.db, 'texts', id)); }
      await deleteDoc(doc(c.db, 'papers', id));
      await clearFlags().catch(() => {});
      dirty(); location.hash = '#/library';
    } catch { msg.textContent = 'Could not remove the paper.'; }
  };
}

async function renderLists() {
  const page = c.el(`<section class="card"><h1>Reading lists</h1><ul id="ll" class="list"></ul>
    <h2>New list</h2><form id="nl" class="stack"><label>Name <input id="lname" required maxlength="80" placeholder="e.g. Obstetric posting"></label>
      <label>About <input id="labout" maxlength="200"></label><button class="primary">Create list</button></form></section>`);
  c.view.replaceChildren(page);
  const ls = await getDocs(collection(c.db, 'lists'));
  const ul = $in(page, '#ll');
  if (ls.empty) ul.append(c.el('<li class="muted">No lists yet.</li>'));
  ls.docs.sort((a, b) => a.data().name.localeCompare(b.data().name)).forEach((d) => ul.append(c.el(
    `<li><a href="#/list/${d.id}">${c.esc(d.data().name)}</a><span class="muted">${d.data().paperIds.length} papers</span></li>`)));
  $in(page, '#nl').onsubmit = async (e) => {
    e.preventDefault();
    const ref = await addDoc(collection(c.db, 'lists'), {
      name: $in(page, '#lname').value.trim(), about: $in(page, '#labout').value.trim(), paperIds: [],
      createdBy: c.user.uid, createdAt: serverTimestamp(),
    });
    location.hash = `#/list/${ref.id}`;
  };
}

async function renderList(lid) {
  const snap = await getDoc(doc(c.db, 'lists', lid));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/lists">Lists</a></p></section>')); return; }
  const l = snap.data();
  const edit = c.member.role === 'admin' || l.createdBy === c.user.uid;
  const page = c.el(`<section class="card"><p><a href="#/lists">← Reading lists</a></p><h1>${c.esc(l.name)}</h1>
    ${l.about ? `<p>${c.esc(l.about)}</p>` : ''}<ul id="lp" class="list"></ul>
    ${edit ? '<p class="muted">Add papers from a paper\'s page.</p><button id="dl" class="link danger">Delete list</button>' : ''}</section>`);
  c.view.replaceChildren(page);
  const { papers } = await loadLibrary();
  const ul = $in(page, '#lp');
  if (!l.paperIds.length) ul.append(c.el('<li class="muted">No papers yet.</li>'));
  l.paperIds.filter((pid) => papers.has(pid)).forEach((pid) => {
    const li = paperItem(pid, papers.get(pid));
    if (edit) {
      const rm = c.el('<button class="link danger">Remove</button>');
      rm.onclick = async () => { await updateDoc(snap.ref, { paperIds: arrayRemove(pid) }); renderList(lid); };
      li.append(rm);
    }
    ul.append(li);
  });
  if (edit) $in(page, '#dl').onclick = async () => {
    if (!confirm('Delete this list? The papers stay in the library.')) return;
    await deleteDoc(snap.ref); location.hash = '#/lists';
  };
}
