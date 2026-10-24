// Saved tab (#/lists): Starred, Recently opened, Private lists; and one list's page (#/list/<id>). Lists are only ever
// the maker's; papers for everyone are grouped with shared tags.
import { doc, getDoc, getDocs, addDoc, deleteDoc, updateDoc, collection, serverTimestamp, arrayRemove } from 'firebase/firestore';
import { loadLists, loadRecent, loadStarred, setStarred, starId, loadNoted, scanNoted } from './prefs.js';
import { sortNotes, filterNotes, millis } from './notes.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function renderSaved(c, loadLibrary, paperItem) {
  const page = c.el(`<section class="card"><h1>Saved</h1>
    <ul class="list nav-list" id="sstar"></ul>
    <h2>Recently opened</h2><ul class="list" id="srecent"><li class="muted">Loading…</li></ul>
    <h2>My notes</h2><input type="search" id="nsearch" placeholder="Search my notes" aria-label="Search my notes" autocomplete="off">
    <ul class="list" id="mynotes"><li class="muted">Loading…</li></ul>
    <h2>Private lists</h2><p class="muted">Only you see your lists. To group papers for everyone, give them a shared tag.</p>
    <ul class="list nav-list" id="smine"></ul>
    <h2>New private list</h2><form id="nl" class="stack"><label>Name <input id="lname" required maxlength="80" placeholder="e.g. Exam revision"></label>
      <label>About <input id="labout" maxlength="200"></label>
      <button class="primary">Create list</button></form></section>`);
  c.view.replaceChildren(page);
  page.querySelector('#nl').onsubmit = async (e) => {
    e.preventDefault();
    const ref = await addDoc(collection(c.db, 'lists'), {
      name: page.querySelector('#lname').value.trim(), about: page.querySelector('#labout').value.trim(), paperIds: [],
      createdBy: c.user.uid, createdAt: serverTimestamp(), visibility: 'private',
    });
    location.hash = `#/list/${ref.id}`;
  };
  const [lists, starred, recent, lib] = await Promise.all([loadLists(c.db, c.user.uid, c.member.role === 'admin'),
    loadStarred(c.db, c.user.uid), loadRecent(c.db, c.user.uid), loadLibrary()]);
  if (!page.isConnected) return;
  const n = [...starred].filter((id) => lib.papers.has(id)).length;
  page.querySelector('#sstar').append(c.el(`<li><a href="#/list/${starId(c.user.uid)}">Starred <span class="muted">&nbsp;· ${plural(n, 'paper')}</span></a></li>`));
  const rl = page.querySelector('#srecent'); rl.replaceChildren();
  const seen = recent.filter((id) => lib.papers.has(id));
  if (!seen.length) rl.append(c.el('<li class="muted">Papers you open show here.</li>'));
  seen.forEach((id) => rl.append(paperItem(id, lib.papers.get(id))));
  const row = (l) => c.el(`<li><a href="#/list/${c.esc(l.id)}">${c.esc(l.name)} <span class="muted">&nbsp;· ${plural(l.paperIds.filter((id) => lib.papers.has(id)).length, 'paper')}</span></a></li>`);
  const mine = lists.filter((l) => !l.starred);
  page.querySelector('#smine').append(...(mine.length ? mine.map(row) : [c.el('<li class="muted">None yet.</li>')]));
  myNotes(c, page, lib);
}

// All my paper notes (found through the small index on my user doc) and my private session notes, newest first.
async function myNotes(c, page, lib) {
  const ul = page.querySelector('#mynotes'), uid = c.user.uid;
  const put = (msg) => ul.replaceChildren(c.el(`<li class="muted">${msg}</li>`));
  let rows = [];
  try {
    const noted = await scanNoted(c.db, uid, lib.papers.keys()).catch(() => loadNoted(c.db, uid));
    const ids = Object.keys(noted);
    for (let i = 0; i < ids.length; i += 10) {
      const got = await Promise.all(ids.slice(i, i + 10).map((pid) => getDoc(doc(c.db, 'papers', pid, 'notes', uid)).catch(() => null)));
      got.forEach((d, j) => {
        const pid = ids[i + j], n = d?.exists() ? d.data() : null;
        if (!n?.text) return;
        const p = lib.papers.get(pid);
        rows.push({ kind: 'paper', id: pid, title: p ? p.title : 'Removed paper', text: n.text, ms: millis(n.updatedAt) || noted[pid], shared: n.shared === true, href: p ? `#/paper/${pid}` : '' });
      });
    }
    // Private session notes are written by the session page; none (or no access yet) simply means no rows.
    const sn = await getDocs(collection(c.db, 'users', uid, 'sessionNotes')).catch(() => null);
    const sess = await Promise.all((sn?.docs || []).filter((d) => d.data().text).map(async (d) => {
      const s = await getDoc(doc(c.db, 'sessions', d.id)).catch(() => null);
      const sd = s?.exists() ? s.data() : null;
      const p = sd && lib.papers.get(sd.paperId);
      const when = sd?.date?.toDate ? sd.date.toDate().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      return { kind: 'session', id: d.id, title: p ? p.title : sd?.paperTitle || 'Journal club session', text: d.data().text, ms: millis(d.data().updatedAt), shared: false, href: sd ? `#/session/${d.id}` : '', when };
    }));
    rows = sortNotes([...rows, ...sess]);
  } catch (e) { console.warn('my notes', e); put('Could not load your notes.'); return; }
  if (!page.isConnected) return;
  const draw = () => {
    const shown = filterNotes(rows, page.querySelector('#nsearch').value);
    if (!shown.length) { put(rows.length ? 'No note matches.' : 'Notes you write on papers and sessions show here.'); return; }
    ul.replaceChildren(...shown.map((r) => c.el(`<li class="mynote"><${r.href ? `a href="${c.esc(r.href)}"` : 'span'}>${c.esc(r.title)}</${r.href ? 'a' : 'span'}>
      <span class="muted">${r.kind === 'session' ? `Session note${r.when ? ' · ' + c.esc(r.when) : ''} · Only me` : `Paper note · ${r.shared ? 'Members' : 'Only me'}`}</span>
      <span class="note-snippet">${c.esc(r.text)}</span></li>`)));
  };
  page.querySelector('#nsearch').oninput = draw;
  draw();
}

export async function renderList(c, lid, loadLibrary, paperItem) {
  const uid = c.user.uid;
  const star = lid === starId(uid);
  const snap = await getDoc(doc(c.db, 'lists', lid)).catch(() => null);
  if (!star && !snap?.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/lists">Saved</a></p></section>')); return; }
  const l = snap?.exists() ? snap.data() : { name: 'Starred', paperIds: [], createdBy: uid, visibility: 'private', kind: 'starred' };
  const owner = c.member.role === 'admin' || l.createdBy === uid;
  const shared = l.visibility !== 'private';
  const mayRemove = owner || shared;
  const page = c.el(`<section class="card"><p><a href="#/lists">← Saved</a></p><h1>${c.esc(l.name)}</h1>
    ${l.about ? `<p>${c.esc(l.about)}</p>` : ''}
    <p class="muted">${star ? 'Only you see your starred papers.' : shared ? 'An older shared list: an admin opening Saved turns it into a shared tag.' : 'Private list: only you see it.'}</p>
    <ul id="lp" class="list"></ul>
    ${owner && !star ? `<details><summary>Edit list</summary><form id="el" class="stack">
      <label>Name <input id="ename" required maxlength="80"></label><label>About <input id="eabout" maxlength="200"></label>
      <button class="primary">Save</button></form><button id="dl" class="danger-btn">Delete list</button></details>` : ''}</section>`);
  c.view.replaceChildren(page);
  const lib = await loadLibrary();
  const ul = page.querySelector('#lp');
  const ids = star ? [...(await loadStarred(c.db, uid))] : l.paperIds;
  const here = ids.filter((pid) => lib.papers.has(pid));
  if (!here.length) ul.append(c.el(`<li class="muted">No papers yet. ${star ? 'Star papers from their page, or select some in the library.' : 'Add papers from a paper\'s page, or select some in the library.'}</li>`));
  here.forEach((pid) => {
    const li = lib.papers.get(pid) && paperItem(pid, lib.papers.get(pid));
    if (mayRemove) {
      const rm = c.el(`<button class="link danger">${star ? 'Unstar' : 'Remove'}</button>`);
      rm.onclick = async () => {
        if (star) await setStarred(c.db, uid, [pid], false); else await updateDoc(snap.ref, { paperIds: arrayRemove(pid) });
        renderList(c, lid, loadLibrary, paperItem);
      };
      li.append(rm);
    }
    ul.append(li);
  });
  const ef = page.querySelector('#el');
  if (ef) {
    ef.querySelector('#ename').value = l.name; ef.querySelector('#eabout').value = l.about || '';
    ef.onsubmit = async (e) => {
      e.preventDefault();
      await updateDoc(snap.ref, { name: ef.querySelector('#ename').value.trim(), about: ef.querySelector('#eabout').value.trim() });
      renderList(c, lid, loadLibrary, paperItem);
    };
    page.querySelector('#dl').onclick = async () => {
      if (!confirm('Delete this list? The papers stay in the library.')) return;
      await deleteDoc(snap.ref); location.hash = '#/lists';
    };
  }
}
