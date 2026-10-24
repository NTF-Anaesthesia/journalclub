import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
  connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, getDoc, getDocs, collection, setDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp, Timestamp, query, orderBy,
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';
import { renderLibraryRoute, LIBRARY_ROUTES, showAuthors, setShowAuthors } from './library.js';
import { timing, withTimeout, diagnostics } from './catalogue.js';
import { refresh as refreshOffline, clearAll as clearOffline, usage as offlineUsage, sizeText } from './offline.js';
import { renderDeckRoute, DECK_ROUTES } from './decks.js';
import { renderClubRoute, CLUB_ROUTES, loadClub, loadTemplate, saveClub, saveTemplate, fieldEditor } from './club.js';

const emulator = new URLSearchParams(location.search).has('emulator') && location.hostname === 'localhost';
// On the live site sign-in runs on this origin: the Worker proxies /__/auth/ to Firebase, so the redirect is first-party.
const live = location.hostname === 'journalclub.anantf.com' ? { authDomain: location.hostname } : {};
// ?emulator=demo-<name> gives a test its own emulator project (the 1000-paper e2e), else demo-jc.
const emuProject = /^demo-[a-z0-9-]{1,30}$/.test(new URLSearchParams(location.search).get('emulator')) ? new URLSearchParams(location.search).get('emulator') : 'demo-jc';
const app = initializeApp(emulator ? { ...firebaseConfig, projectId: emuProject } : { ...firebaseConfig, ...live });
const EMU_SECRET = ['emu', 'only', '1'].join('-');
const auth = getAuth(app);
// Persistent cache: the library catalogue is read from IndexedDB on repeat opens (src/library.js loadLibrary).
// Auto-detect long polling: some phone networks stall Firestore's streaming channel, and every read that needs it then
// waits for the SDK's 10 s offline timeout (src/catalogue.js timings). The SDK falls back to long polling when it must.
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), experimentalAutoDetectLongPolling: true });

if (emulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  // Test hook, present only against local emulators: email/password stands in for the Google popup.
  window.__jc = {
    async signIn(email) {
      try { await createUserWithEmailAndPassword(auth, email, EMU_SECRET); }
      catch { await signInWithEmailAndPassword(auth, email, EMU_SECRET); }
    },
    db, auth, doc, setDoc,
  };
}

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let user = null;       // Firebase user or null
let member = null;     // members/{uid} data or null
let ready = false;

// The member row is kept on this device so the app opens offline; a read that says "no such member" always wins.
const memberKey = (uid) => `jc.member.${uid}`;
async function loadMember() {
  member = null;
  if (!user) return;
  const t0 = performance.now(), uid = user.uid;
  const apply = (snap) => {
    member = snap.exists() ? snap.data() : null;
    if (!member) clearOffline().catch(() => {}); // removed members lose their offline papers
    try { if (member) localStorage.setItem(memberKey(uid), JSON.stringify({ role: member.role, name: member.name || '', email: member.email || '' })); else localStorage.removeItem(memberKey(uid)); } catch { /* ignore */ }
  };
  const saved = () => { try { return JSON.parse(localStorage.getItem(memberKey(uid)) || 'null'); } catch { return null; } };
  const fresh = getDoc(doc(db, 'members', uid));
  try {
    // A stalled stream must not hold the whole app for the SDK's 10 s offline timeout: after 2 s a member seen before
    // is taken from this device, and the server's answer replaces it when it comes.
    try { apply(await withTimeout(fresh, 2000, 'member')); }
    catch (e) {
      if (e.code !== 'timeout') throw e;
      timing.memberError = 'timeout';
      if (saved()) { member = saved(); fresh.then((s) => { if (user?.uid === uid) apply(s); }).catch(() => {}); }
      else apply(await fresh);
    }
  } catch (e) {
    console.error('loadMember', e.code, e.message);
    member = e.code === 'unavailable' || navigator.onLine === false ? saved() : null;
  }
  timing.member = Math.round(performance.now() - t0);
}

function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, arg, arg2] = path.split('/');
  return { name: name || 'home', arg, arg2, q: new URLSearchParams(qs || '').get('q') || '' };
}

// Pages load before they show: one whose route was left meanwhile must not replace the newer page.
let renders = 0;
function render() {
  const mine = ++renders;
  if (!ready) { view.replaceChildren(el('<p class="muted">Loading…</p>')); return; }
  renderBar();
  const r = route();
  if (r.name === 'join' && r.arg) return renderJoin(r.arg);
  if (!user) return renderSignedOut();
  if (r.name === 'me' || r.name === 'settings') return renderMe();
  if (!member) return renderNotMember();
  if (r.name === 'admin') return member.role === 'admin' ? renderAdmin() : renderDenied();
  const ctx = { db, user, member, view: { replaceChildren: (...n) => { if (mine === renders) view.replaceChildren(...n); } }, el, esc };
  if (LIBRARY_ROUTES.includes(r.name)) return renderLibraryRoute(r, ctx);
  if (CLUB_ROUTES.includes(r.name)) return renderClubRoute(r, ctx);
  if (DECK_ROUTES.includes(r.name)) return renderDeckRoute(r, ctx);
  return renderClubRoute({ name: 'home' }, ctx);
}

// Bottom tab bar (members only; Club, Calendar, Library, Saved, Settings; club home is the default page, also #/home and
// #/sessions; Settings is also #/me) and the top bar: its title fades in once the page's large title scrolls away.
const TABS = [
  ['', 'Club', '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.8-3.6 3.2-5.5 6-5.5s5.2 1.9 6 5.5"/><circle cx="16.5" cy="9" r="2.6"/><path d="M16 14.6c2.6 0 4.4 1.7 5 5.4"/>'],
  ['calendar', 'Calendar', '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
  ['library', 'Library', '<path d="M5 4h3v16H5zM10 4h3v16h-3z"/><path d="m15.5 4.8 2.9-.8 3.6 15.4-2.9.8z"/>'],
  ['lists', 'Saved', '<path d="M6 4h12v16l-6-4-6 4z"/>'],
  ['settings', 'Settings', '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'],
];
const TAB_OF = { library: 'library', add: 'library', import: 'library', paper: 'library', read: 'library', remove: 'library', reindex: 'library',
  duplicates: 'library', deck: 'library', view: 'library', lists: 'lists', list: 'lists', home: '', sessions: '', session: '', point: '', plan: '', calendar: 'calendar',
  settings: 'settings', me: 'settings', admin: 'settings' };
const PERSON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';

function renderBar() {
  const bar = $('#bar'), tabbar = $('#tabbar');
  const on = !!(user && member);
  tabbar.hidden = !on;
  document.body.classList.toggle('app-has-tabbar', on);
  // Members reach their account from the Settings tab; signed-in non-members keep the button to sign out.
  if (!user || on) bar.replaceChildren(); else bar.replaceChildren(el(`<a class="app-bar-btn" href="#/me" aria-label="Account">${PERSON}</a>`));
  if (!on) return;
  const cur = TAB_OF[route().name] ?? null;
  $('#tabs').innerHTML = TABS.map(([k, t, icon]) => `<a class="app-tab" href="#/${k}"${k === cur ? ' aria-current="page"' : ''}>
    <span class="app-tab-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span><span>${t}</span></a>`).join('');
}

let titleWatch = null;
function watchTitle() {
  titleWatch?.disconnect();
  const top = $('#topbar'), h = view.querySelector('h1');
  $('#bar-title').textContent = h?.textContent.trim() || 'Journal Club';
  if (!h || !('IntersectionObserver' in window)) { top.classList.add('is-collapsed'); return; }
  top.classList.toggle('is-collapsed', h.getBoundingClientRect().bottom < 56);
  titleWatch = new IntersectionObserver(([e]) => top.classList.toggle('is-collapsed', !e.isIntersecting), { rootMargin: '-56px 0px 0px 0px' });
  titleWatch.observe(h);
}
// Pages render asynchronously; re-attach the watcher whenever the page's heading changes.
let lastH1 = null;
new MutationObserver(() => { const h = view.querySelector('h1'); if (h !== lastH1) { lastH1 = h; watchTitle(); } })
  .observe(view, { childList: true, subtree: true });

async function renderMe() {
  const admin = member?.role === 'admin';
  const page = el(`<section class="card"><h1>Settings</h1>
    <h2>Account</h2>
    <ul class="list"><li><span>${esc(member?.name || user.displayName || '')}<br><span class="muted">${esc(user.email)}</span></span>
      ${member ? `<span class="muted">${esc(member.role)}</span>` : ''}</li></ul>
    ${admin ? '<h2>Journal club</h2><ul class="list nav-list"><li><a href="#/admin">Admin</a></li></ul>' : ''}
    ${member ? `<h2>Preferences</h2><ul class="list"><li><label class="check-row"><input type="checkbox" id="sauth"${showAuthors() ? ' checked' : ''}><span class="grow">Show authors in the library</span></label></li></ul>` : ''}
    <h2>Offline papers</h2><p class="muted" id="offinfo">Counting…</p>
    <p><button id="offclear" type="button">Clear offline papers</button></p>
    <h2>Trouble loading?</h2><p class="muted">If the library hangs or is slow, copy this and send it to the admin.</p>
    <p><button id="diag" type="button">Copy diagnostics</button> <span class="muted" id="diagmsg" role="status"></span></p>
    <p><button id="out" class="danger-btn">Sign out</button></p></section>`);
  const sa = page.querySelector('#sauth');
  if (sa) sa.onchange = () => setShowAuthors(sa.checked);
  page.querySelector('#out').onclick = async () => { await clearOffline().catch(() => {}); signOut(auth); };
  page.querySelector('#diag').onclick = async () => {
    const text = diagnostics(), msg = page.querySelector('#diagmsg');
    try { await navigator.clipboard.writeText(text); msg.textContent = 'Copied.'; } catch { msg.textContent = text; }
  };
  const info = page.querySelector('#offinfo');
  const showUsage = async () => { const u = await offlineUsage(); info.textContent = u.count ? `${u.count} ${u.count === 1 ? 'paper' : 'papers'} saved on this device, ${sizeText(u.bytes)}. Starred papers and the last 20 you opened are kept.` : 'No papers saved on this device yet. Starred papers and the last 20 you opened are kept.'; };
  page.querySelector('#offclear').onclick = async () => { await clearOffline(); showUsage(); };
  showUsage();
  view.replaceChildren(page);
}

function signInButton() {
  const b = el('<button class="primary" id="gsign">Sign in with Google</button>');
  b.onclick = async () => {
    // Redirect, not popup: popups lose their way back in installed web apps (Firefox web app, home-screen apps).
    try { await signInWithRedirect(auth, new GoogleAuthProvider()); }
    catch (e) { alert('Sign-in failed: ' + e.code); }
  };
  return b;
}

function renderSignedOut() {
  const card = el(`<section class="card welcome"><img class="welcome-mark" src="icons/icon.svg" alt="" width="72" height="72">
    <p class="eyebrow">NTF Anaesthesia</p><h1>Join the club</h1>
    <p class="welcome-lead">Read, present and talk through the papers that shape our practice, together.</p>
    <ul class="welcome-points">
      <li><strong>Club</strong><span>The next session, who presents, and your take-home point.</span></li>
      <li><strong>Library</strong><span>Every paper and slide deck we have read, searchable down to the page.</span></li>
      <li><strong>Saved</strong><span>Your starred papers and reading lists, also offline.</span></li>
    </ul>
    <p class="actions" id="signin"></p>
    <p class="muted">Members only. Got an invite link? Open it, then sign in with Google.</p></section>`);
  card.querySelector('#signin').append(signInButton());
  view.replaceChildren(card);
}

function renderNotMember() {
  const card = el(`<section class="card"><h1>Not a member yet</h1>
    <p>${esc(user.email)} is not on the members list. Ask an admin for an invite link.</p></section>`);
  view.replaceChildren(card);
}

function renderDenied() {
  view.replaceChildren(el('<section class="card"><h1>Admins only</h1><p><a href="#/">Back</a></p></section>'));
}

async function renderJoin(token) {
  const card = el('<section class="card"><h1>Join the Journal Club</h1><p id="jmsg" class="muted">Checking invite…</p></section>');
  view.replaceChildren(card);
  const msg = card.querySelector('#jmsg');
  if (!user) {
    msg.textContent = 'Sign in with Google to accept your invite.';
    card.append(signInButton());
    return;
  }
  if (member) { msg.textContent = 'You are already a member.'; card.append(el('<p><a href="#/">Continue</a></p>')); return; }
  let inv;
  try { inv = await getDoc(doc(db, 'invites', token)); } catch { inv = null; }
  const data = inv?.exists() ? inv.data() : null;
  const group = data?.group === true;
  if (!data || (!group && data.used) || data.expiresAt.toMillis() <= Date.now()) {
    msg.textContent = 'This invite link is not valid any more (used, expired or mistyped). Ask for a new one.';
    return;
  }
  msg.textContent = `Join as ${user.email}?`;
  const btn = el('<button class="primary" id="accept">Accept invite</button>');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const b = writeBatch(db);
      if (!group) b.update(doc(db, 'invites', token), { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
      b.set(doc(db, 'members', user.uid), {
        email: user.email, name: user.displayName || '', role: 'member', inviteId: token, joinedAt: serverTimestamp(),
      });
      await b.commit();
      await loadMember();
      location.hash = '#/';
      render();
    } catch {
      msg.textContent = 'Could not accept the invite. It may have just been used or expired.';
      btn.disabled = false;
    }
  };
  card.append(btn);
}

function newToken() {
  const a = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function renderAdmin() {
  const page = el(`<section class="card"><h1>Admin</h1>
    <h2>Invite someone</h2>
    <form id="inv"><input id="note" placeholder="Note (who it is for)" maxlength="80">
      <select id="days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select>
      <button class="primary" id="mk1">Create invite link</button>
      <button type="button" id="mkgrp">Create group link</button></form>
    <p class="muted">A single-use link admits one person. A group link admits anyone who signs in with it before it expires.</p>
    <p id="newlink" class="muted"></p>
    <h2>Removal flags</h2><ul id="flags" class="list"></ul>
    <h2>Open invites</h2><ul id="invites" class="list"></ul>
    <h2>Members</h2><ul id="members" class="list"></ul>
    <h2>Meeting</h2>
    <form id="club" class="stack"><label>Standing Teams link <input id="cteams" type="url" placeholder="https://…" pattern="https://.*"></label>
      <label>Default start time <input id="ctime" type="time"></label>
      <label>Usual weekday <select id="cday"><option value="">None</option>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></label>
      <label>Prompt for members' points <input id="cprompt" maxlength="120"></label>
      <button class="primary">Save meeting settings</button><p id="cmsg" class="muted"></p></form>
    <h2>Discussion form</h2><p class="muted">Applies to all future sessions. A session can override it on its own page.</p>
    <div id="dform"></div></section>`);
  view.replaceChildren(page);
  const ctx = { db, user, member, view: { replaceChildren: (...n) => { if (mine === renders) view.replaceChildren(...n); } }, el, esc };
  Promise.all([loadClub(ctx), loadTemplate(ctx)]).then(([club, fields]) => {
    page.querySelector('#cteams').value = club.teamsUrl || '';
    page.querySelector('#ctime').value = club.time || '';
    page.querySelector('#cday').value = Number.isInteger(club.weekday) ? String(club.weekday) : '';
    page.querySelector('#cprompt').value = club.pointPrompt || '';
    page.querySelector('#dform').append(fieldEditor(ctx, fields, (f) => saveTemplate(ctx, f)));
  });
  page.querySelector('#club').onsubmit = async (e) => {
    e.preventDefault();
    const msg = page.querySelector('#cmsg');
    const teamsUrl = page.querySelector('#cteams').value.trim();
    if (teamsUrl && !/^https:\/\/[^\s"<>]+$/.test(teamsUrl)) { msg.textContent = 'The link must start with https://'; return; }
    try {
      await saveClub(ctx, { teamsUrl, time: page.querySelector('#ctime').value, pointPrompt: page.querySelector('#cprompt').value.trim(),
        ...(page.querySelector('#cday').value === '' ? {} : { weekday: Number(page.querySelector('#cday').value) }) });
      msg.textContent = 'Saved.';
    } catch { msg.textContent = 'Could not save.'; }
  };

  async function refresh() {
    const [ms, is, fs] = await Promise.all([
      getDocs(collection(db, 'members')),
      getDocs(query(collection(db, 'invites'), orderBy('createdAt', 'desc'))),
      getDocs(query(collection(db, 'flags'), orderBy('at', 'desc'))),
    ]);
    const joinedVia = new Map();
    ms.forEach((d) => { const m = d.data(); joinedVia.set(m.inviteId, [...(joinedVia.get(m.inviteId) || []), m.name || m.email]); });
    const fl = page.querySelector('#flags'); fl.replaceChildren();
    if (fs.empty) fl.append(el('<li class="muted">No open flags.</li>'));
    fs.forEach((d) => {
      const f = d.data();
      const li = el(`<li><span><a href="#/paper/${esc(f.paperId)}">${esc(f.paperTitle)}</a> <span class="muted">${f.what === 'pdf' ? 'PDF' : 'whole paper'} · ${esc(f.byName)}</span><br>${esc(f.reason)}</span></li>`);
      const rm = el('<button class="link danger">Remove</button>');
      rm.onclick = () => { location.hash = `#/remove/${f.paperId}`; };
      const dm = el('<button class="link">Dismiss</button>');
      dm.onclick = async () => { await deleteDoc(d.ref); refresh(); };
      li.append(rm, dm); fl.append(li);
    });
    const ml = page.querySelector('#members'); ml.replaceChildren();
    ms.forEach((d) => {
      const m = d.data();
      const li = el(`<li><span>${esc(m.name || m.email)} <span class="muted">${esc(m.email)} · ${esc(m.role)}</span></span></li>`);
      if (d.id !== user.uid) {
        const role = el(`<button class="link">${m.role === 'admin' ? 'Make member' : 'Make admin'}</button>`);
        role.onclick = async () => { await updateDoc(d.ref, { role: m.role === 'admin' ? 'member' : 'admin' }); refresh(); };
        const rm = el('<button class="link danger">Remove</button>');
        rm.onclick = async () => { if (confirm('Remove ' + m.email + '?')) { await deleteDoc(d.ref); refresh(); } };
        li.append(role, rm);
      }
      ml.append(li);
    });
    const il = page.querySelector('#invites'); il.replaceChildren();
    is.forEach((d) => {
      const i = d.data();
      if (i.used) return;
      const exp = i.expiresAt.toDate();
      const who = i.group ? joinedVia.get(d.id) || [] : [];
      const li = el(`<li><span>${i.group ? '<strong>Group</strong> ' : ''}${esc(i.note || '(no note)')} <span class="muted">expires ${exp.toLocaleDateString()}${exp < new Date() ? ' (expired)' : ''}</span>${i.group ? `<br><span class="muted">Joined: ${who.length ? esc(who.join(', ')) : 'nobody yet'}</span>` : ''}</span></li>`);
      const cp = el('<button class="link">Copy link</button>');
      cp.onclick = () => navigator.clipboard?.writeText(`${location.origin}/#/join/${d.id}`);
      const rv = el('<button class="link danger">Revoke</button>');
      rv.onclick = async () => { await deleteDoc(d.ref); refresh(); };
      li.append(cp, rv); il.append(li);
    });
  }

  async function makeInvite(group) {
    const token = newToken();
    const days = Number(page.querySelector('#days').value);
    await setDoc(doc(db, 'invites', token), {
      createdBy: user.uid, createdAt: serverTimestamp(), used: false,
      expiresAt: Timestamp.fromMillis(Date.now() + days * 86400000),
      note: page.querySelector('#note').value.trim(), ...(group ? { group: true } : {}),
    });
    const link = `${location.origin}/#/join/${token}`;
    page.querySelector('#newlink').innerHTML = `${group ? 'Group link' : 'One-time link'}: <code id="linktext">${esc(link)}</code>`;
    page.querySelector('#note').value = '';
    refresh();
  }
  page.querySelector('#inv').onsubmit = (e) => { e.preventDefault(); makeInvite(false); };
  page.querySelector('#mkgrp').onclick = () => makeInvite(true);
  refresh();
}

// Offline shell: the Service Worker keeps the app itself; src/offline.js keeps the PDFs.
function startServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(async () => {
    const sw = (await navigator.serviceWorker.ready).active;
    // The reader and PDF.js load on demand: fetch them now so they are cached before the first flight.
    await Promise.allSettled([import('./reader.js'), fetch('/pdf.worker.min.mjs')]);
    sw?.postMessage({ type: 'precache', urls: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => !n.includes('/api/')) });
  }).catch(() => {});
}

onAuthStateChanged(auth, async (u) => {
  const was = user;
  user = u;
  if (!u && was) await clearOffline().catch(() => {}); // signed out, in this tab or another
  await loadMember();
  await refreshOffline().catch(() => {});
  if (u && member) startServiceWorker();
  ready = true;
  render();
});
getRedirectResult(auth).catch((e) => alert('Sign-in failed: ' + e.code));
// A tap anywhere on a list card (paper, session, deck) opens its page: the card's first link, unless the tap was on another
// link or control, a page handled it (selecting in the library), or the reader was selecting text.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const card = e.target.closest('li.paper, .tap-card');
  if (!card || e.target.closest('a, button, input, select, textarea, label, .pick') || document.body.classList.contains('selecting')) return;
  if (String(getSelection?.() || '').length) return;
  const a = card.querySelector('a[href^="#/"]');
  if (a) location.hash = a.getAttribute('href');
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
render();
