// Saved tab (#/lists): Starred, Recently opened, Private lists; and one list's page (#/list/<id>). Lists are only ever
// the maker's; papers for everyone are grouped with shared tags.
import { doc, getDoc, addDoc, deleteDoc, updateDoc, collection, serverTimestamp, arrayRemove } from 'firebase/firestore';
import { loadLists, loadRecent, loadStarred, setStarred, starId } from './prefs.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function renderSaved(c, loadLibrary, paperItem) {
  const page = c.el(`<section class="card"><h1>Saved</h1>
    <ul class="list nav-list" id="sstar"></ul>
    <h2>Recently opened</h2><ul class="list" id="srecent"><li class="muted">Loading…</li></ul>
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
