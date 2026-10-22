import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
  connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, setDoc, deleteDoc, updateDoc,
  writeBatch, serverTimestamp, Timestamp, query, orderBy,
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';

const emulator = new URLSearchParams(location.search).has('emulator') && location.hostname === 'localhost';
// On the live site sign-in runs on this origin: the Worker proxies /__/auth/ to Firebase, so the redirect is first-party.
const live = location.hostname === 'journalclub.anantf.com' ? { authDomain: location.hostname } : {};
const app = initializeApp(emulator ? { ...firebaseConfig, projectId: 'demo-jc' } : { ...firebaseConfig, ...live });
const EMU_SECRET = ['emu', 'only', '1'].join('-');
const auth = getAuth(app);
const db = getFirestore(app);

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

async function loadMember() {
  member = null;
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, 'members', user.uid));
    member = snap.exists() ? snap.data() : null;
  } catch (e) { console.error('loadMember', e.code, e.message); member = null; }
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, arg] = hash.split('/');
  return { name: name || 'home', arg };
}

function render() {
  if (!ready) { view.replaceChildren(el('<p class="muted">Loading…</p>')); return; }
  renderBar();
  const r = route();
  if (r.name === 'join' && r.arg) return renderJoin(r.arg);
  if (!user) return renderSignedOut();
  if (!member) return renderNotMember();
  if (r.name === 'admin') return member.role === 'admin' ? renderAdmin() : renderDenied();
  return renderHome();
}

function renderBar() {
  const bar = $('#bar');
  if (!user) { bar.replaceChildren(); return; }
  const admin = member?.role === 'admin' ? '<a href="#/admin">Admin</a>' : '';
  bar.replaceChildren(el(`<span>${admin} <span class="muted">${esc(user.email)}</span> <button id="out" class="link">Sign out</button></span>`));
  $('#out').onclick = () => signOut(auth);
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
  const card = el(`<section class="card"><h1>Journal Club</h1>
    <p>A members-only library and journal club for the department. Access is by invitation.</p>
    <p class="muted">Have an invite link? Open it, then sign in.</p></section>`);
  card.append(signInButton());
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

function renderHome() {
  view.replaceChildren(el(`<section class="card"><h1>Welcome, ${esc(member.name || user.email)}</h1>
    <p>You are a member. The library and journal club arrive in the next releases.</p></section>`));
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
  if (!data || data.used || data.expiresAt.toMillis() <= Date.now()) {
    msg.textContent = 'This invite link is not valid any more (used, expired or mistyped). Ask for a new one.';
    return;
  }
  msg.textContent = `Join as ${user.email}?`;
  const btn = el('<button class="primary" id="accept">Accept invite</button>');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const b = writeBatch(db);
      b.update(doc(db, 'invites', token), { used: true, usedBy: user.uid, usedAt: serverTimestamp() });
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
      <button class="primary">Create invite link</button></form>
    <p id="newlink" class="muted"></p>
    <h2>Open invites</h2><ul id="invites" class="list"></ul>
    <h2>Members</h2><ul id="members" class="list"></ul></section>`);
  view.replaceChildren(page);

  async function refresh() {
    const [ms, is] = await Promise.all([
      getDocs(collection(db, 'members')),
      getDocs(query(collection(db, 'invites'), orderBy('createdAt', 'desc'))),
    ]);
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
      const li = el(`<li><span>${esc(i.note || '(no note)')} <span class="muted">expires ${exp.toLocaleDateString()}${exp < new Date() ? ' (expired)' : ''}</span></span></li>`);
      const cp = el('<button class="link">Copy link</button>');
      cp.onclick = () => navigator.clipboard?.writeText(`${location.origin}/#/join/${d.id}`);
      const rv = el('<button class="link danger">Revoke</button>');
      rv.onclick = async () => { await deleteDoc(d.ref); refresh(); };
      li.append(cp, rv); il.append(li);
    });
  }

  page.querySelector('#inv').onsubmit = async (e) => {
    e.preventDefault();
    const token = newToken();
    const days = Number(page.querySelector('#days').value);
    await setDoc(doc(db, 'invites', token), {
      createdBy: user.uid, createdAt: serverTimestamp(), used: false,
      expiresAt: Timestamp.fromMillis(Date.now() + days * 86400000),
      note: page.querySelector('#note').value.trim(),
    });
    const link = `${location.origin}/#/join/${token}`;
    page.querySelector('#newlink').innerHTML = `One-time link: <code id="linktext">${esc(link)}</code>`;
    page.querySelector('#note').value = '';
    refresh();
  };
  refresh();
}

onAuthStateChanged(auth, async (u) => {
  user = u;
  await loadMember();
  ready = true;
  render();
});
getRedirectResult(auth).catch((e) => alert('Sign-in failed: ' + e.code));
window.addEventListener('hashchange', render);
render();
