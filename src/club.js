// Journal club pages: home (next session), the Plan a session sheet, session pages.
import qrcode from 'qrcode-generator';
import { decodeEntities, cleanPaper } from './abstract.js';
import {
  doc, getDoc, getDocs, collection, collectionGroup, setDoc, updateDoc, query, where, orderBy,
  limit, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

import { dirty as dirtyLibrary } from './library.js';
import {
  DEFAULT_FIELDS, DEFAULT_PROMPT, DEFAULT_TIME, normalizeFields, snapshot, sessionFields, startMillis, inJoinWindow,
  sessionMarkdown, csvExport,
} from './discussion.js';
import { fieldEditor, discussionForm, discussionView } from './discussion-ui.js';

export const CLUB_ROUTES = ['home', 'plan', 'sessions', 'session', 'point'];

let c;              // { db, user, member, view, el, esc } for the current render

const $in = (root, sel) => root.querySelector(sel);
const isAdmin = () => c.member.role === 'admin';
const fmtDate = (ts) => ts.toDate().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Timestamp.fromDate(d); };
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/.test(u || '') ? u : '');

// Club settings (Teams link, prompt, default start time) and the default discussion form live in config/*.
export async function loadClub(ctx = c) {
  const s = await getDoc(doc(ctx.db, 'config', 'club')).catch(() => null);
  return { teamsUrl: '', pointPrompt: DEFAULT_PROMPT, time: DEFAULT_TIME, ...(s?.exists() ? s.data() : {}) };
}
export async function loadTemplate(ctx = c) {
  const s = await getDoc(doc(ctx.db, 'config', 'discussion')).catch(() => null);
  const f = s?.exists() ? normalizeFields(s.data().fields) : [];
  return f.length ? f : DEFAULT_FIELDS;
}
export const saveClub = (ctx, patch) => setDoc(doc(ctx.db, 'config', 'club'), { ...patch, updatedBy: ctx.user.uid, updatedAt: serverTimestamp() });
export const saveTemplate = (ctx, fields) => setDoc(doc(ctx.db, 'config', 'discussion'), { fields, updatedBy: ctx.user.uid, updatedAt: serverTimestamp() });
export { fieldEditor };

export function renderClubRoute(r, ctx) {
  c = ctx;
  if (r.name === 'plan') return renderPlan(r.arg === '-' ? '' : r.arg, r.arg2);
  if (r.name === 'sessions') return renderSessions();
  if (r.name === 'session' && r.arg) return renderSession(r.arg);
  if (r.name === 'point' && r.arg) return renderPoint(r.arg);
  return renderHome();
}

async function nextSession() {
  const s = await getDocs(query(collection(c.db, 'sessions'), where('date', '>=', startOfToday()), orderBy('date'), limit(1)));
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}

async function renderHome() {
  const page = c.el(`<section class="card"><h1>Journal Club</h1>
    <h2>Next session</h2><div id="next"><p class="muted">Loading…</p></div>
    <p class="actions"><a class="button primary" href="#/plan">Plan a session</a> <a href="#/sessions">All sessions</a> <a href="#/library">Library</a></p></section>`);
  c.view.replaceChildren(page);
  const [next, club] = await Promise.all([nextSession(), loadClub()]);
  $in(page, '#next').replaceChildren(next
    ? c.el(`<p class="next"><a href="#/session/${next.id}"><strong>${c.esc(fmtDate(next.date))}</strong></a><br>
        ${c.esc(decodeEntities(next.paperTitle))}<br><span class="muted">Presenter: ${c.esc(next.presenterName || '—')}${next.coordinatorName ? ` · Coordinator: ${c.esc(next.coordinatorName)}` : ''}</span></p>`)
    : c.el('<p class="muted">No session planned yet.</p>'));
  const url = next && safeUrl(next.teamsUrl || club.teamsUrl);
  if (url && inJoinWindow(startMillis(next, club.time), Date.now())) {
    $in(page, '#next').append(c.el(`<p><a class="button primary" id="join" href="${c.esc(url)}" target="_blank" rel="noopener">Join on Teams</a></p>`));
  }
}

async function renderSessions() {
  const page = c.el(`<section class="card"><h1>Sessions</h1>
    <p class="actions"><a class="button primary" href="#/plan">Plan a session</a></p>
    <h2>Upcoming</h2><ul id="up" class="list"></ul><h2>Past</h2><ul id="past" class="list"></ul></section>`);
  c.view.replaceChildren(page);
  const ss = await getDocs(query(collection(c.db, 'sessions'), orderBy('date')));
  const today = startOfToday().toMillis();
  const up = $in(page, '#up'); const past = $in(page, '#past');
  ss.forEach((d) => {
    const s = d.data();
    const li = c.el(`<li class="paper"><a href="#/session/${d.id}">${c.esc(fmtDate(s.date))}</a>
      <span>${c.esc(decodeEntities(s.paperTitle))}</span><span class="muted">${c.esc(s.presenterName || '')}${s.coordinatorName ? ` · ${c.esc(s.coordinatorName)}` : ''}</span></li>`);
    if (s.date.toMillis() >= today) up.append(li); else past.prepend(li);
  });
  if (!up.children.length) up.append(c.el('<li class="muted">None planned.</li>'));
  if (!past.children.length) past.append(c.el('<li class="muted">None yet.</li>'));
  if (isAdmin()) page.append(exportPanel());
}

const download = (name, type, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const ymd = (v) => (v ? Timestamp.fromDate(new Date(`${v}T00:00:00`)) : null);

// Admin: the whole archive as CSV or Markdown, optionally between two dates.
function exportPanel() {
  const box = c.el(`<form class="stack" id="exp"><h2>Export all sessions</h2>
    <label>From <input id="xfrom" type="date"></label><label>To <input id="xto" type="date"></label>
    <span class="actions"><button type="button" class="primary" id="xcsv">Download CSV</button>
    <button type="button" class="link" id="xmd">Download Markdown</button></span><p class="muted" id="xmsg"></p></form>`);
  const gather = async () => {
    const [ss, ps, template] = await Promise.all([
      getDocs(query(collection(c.db, 'sessions'), orderBy('date'))), getDocs(collectionGroup(c.db, 'points')), loadTemplate()]);
    const from = ymd($in(box, '#xfrom').value); const to = ymd($in(box, '#xto').value);
    const sessions = ss.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => (!from || s.date.toMillis() >= from.toMillis()) && (!to || s.date.toMillis() <= to.toMillis()));
    const points = {};
    ps.forEach((d) => { (points[d.ref.parent.parent.id] ||= []).push(d.data()); });
    return { sessions, points, template };
  };
  $in(box, '#xcsv').onclick = async () => {
    const { sessions, points, template } = await gather();
    download('journal-club.csv', 'text/csv', csvExport(sessions, template, points));
    $in(box, '#xmsg').textContent = `${sessions.length} sessions exported.`;
  };
  $in(box, '#xmd').onclick = async () => {
    const { sessions, points, template } = await gather();
    download('journal-club.md', 'text/markdown', sessions.map((s) => sessionMarkdown(s, template, points[s.id] || [])).join('\n'));
    $in(box, '#xmsg').textContent = `${sessions.length} sessions exported.`;
  };
  return box;
}

// Keep a paper's `presented` summary ([{sid, date}], oldest first) in step with its sessions, inside the session's batch.
async function setPresented(b, paperId, sid, date) {
  const ref = doc(c.db, 'papers', paperId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const list = (snap.data().presented || []).filter((e) => e.sid !== sid);
  if (date) list.push({ sid, date });
  list.sort((x, y) => x.date.toMillis() - y.date.toMillis());
  b.update(ref, { presented: list });
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The club's usual weekday (admin setting), as the next such date from today; blank if none is set.
function usualDate(club) {
  if (!Number.isInteger(club.weekday)) return '';
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((club.weekday - d.getDay() + 7) % 7));
  return isoDay(d);
}

const mayPlanSession = (s) => isAdmin() || (!s.locked && [s.createdBy, s.presenterUid, s.coordinatorUid].includes(c.user.uid));

// One quick sheet for planning (or editing) a session: date, paper by search-as-you-type, presenter, coordinator,
// optional Teams link. Any member may plan; `#/plan/<paper>` opens it with that paper chosen, `#/plan/-/<sid>` edits.
async function renderPlan(paperId, sid) {
  const oldSnap = sid ? await getDoc(doc(c.db, 'sessions', sid)) : null;
  if (sid && !oldSnap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/sessions">Sessions</a></p></section>')); return; }
  const old = oldSnap ? oldSnap.data() : null;
  if (old && !mayPlanSession(old)) {
    c.view.replaceChildren(c.el(`<section class="card"><h1>Not allowed</h1><p>Only the person who planned this session, its presenter, its coordinator or an admin can change it.</p><p><a href="#/session/${c.esc(sid)}">Back to the session</a></p></section>`));
    return;
  }
  const [ps, ss, club] = await Promise.all([getDocs(collection(c.db, 'papers')), getDocs(collection(c.db, 'sessions')), loadClub()]);
  const papers = ps.docs.map((d) => cleanPaper({ id: d.id, ...d.data() }))
    .map((p) => ({ id: p.id, title: p.title, hay: `${p.title} ${p.authors.join(' ')} ${p.year || ''}`.toLowerCase() }));
  // Names for the pickers: people on earlier sessions, plus the whole member list for admins (members can't list it).
  const people = new Map();
  const note = (name, uid) => { if (name && (uid || !people.has(name))) people.set(name, uid || ''); };
  ss.forEach((d) => { const x = d.data(); note(x.presenterName, x.presenterUid); note(x.coordinatorName, x.coordinatorUid); });
  const me = c.member.name || c.user.displayName || c.user.email;
  note(me, c.user.uid);
  if (isAdmin()) (await getDocs(collection(c.db, 'members'))).forEach((d) => note(d.data().name || d.data().email, d.id));

  const page = c.el(`<section class="card"><p><a href="#/${sid ? 'session/' + c.esc(sid) : 'sessions'}">← ${sid ? 'Session' : 'Sessions'}</a></p>
    <h1>${sid ? 'Edit session' : 'Plan a session'}</h1>
    <form id="pf" class="stack">
      <label>Date <input id="sdate" type="date" required></label><p id="sclash" class="muted"></p>
      <label>Paper <input id="spaper" type="search" autocomplete="off" placeholder="Search the library by title or author"></label>
      <ul id="spick" class="list"></ul>
      <label>Presenter <input id="spres" list="people" maxlength="120" placeholder="Pick a member or type a name"></label>
      <label>Coordinator <input id="scoord" list="people" maxlength="120" placeholder="Pick a member or type a name"></label>
      <datalist id="people">${[...people.keys()].map((n) => `<option value="${c.esc(n)}">`).join('')}</datalist>
      <label>Teams link for this session (optional) <input id="steams" type="url" placeholder="https://… (blank = standing link)" pattern="https://.*"></label>
      <button class="primary">${sid ? 'Save' : 'Plan session'}</button><p id="smsg" class="muted"></p></form></section>`);
  c.view.replaceChildren(page);
  const form = $in(page, '#pf'); const msg = $in(form, '#smsg');
  const find = $in(form, '#spaper'); const pick = $in(form, '#spick');

  let paper = papers.find((p) => p.id === (old ? old.paperId : paperId)) || (old ? { id: old.paperId, title: decodeEntities(old.paperTitle) } : null);
  if (paper) find.value = paper.title;
  find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    if (paper && find.value !== paper.title) paper = null;
    pick.replaceChildren();
    if (!q || paper) return;
    const words = q.split(/\s+/);
    papers.filter((p) => words.every((w) => p.hay.includes(w))).slice(0, 8).forEach((p) => {
      const li = c.el('<li></li>'); const b = c.el('<button type="button" class="link"></button>');
      b.textContent = p.title;
      b.onclick = () => { paper = p; find.value = p.title; pick.replaceChildren(); };
      li.append(b); pick.append(li);
    });
    if (!pick.children.length) pick.append(c.el('<li class="muted">No paper matches. <a href="#/add">Add it to the library</a>.</li>'));
  };

  const date = $in(form, '#sdate');
  date.value = old ? isoDay(old.date.toDate()) : usualDate(club);
  const clash = () => {
    const same = ss.docs.filter((d) => d.id !== sid && date.value && isoDay(d.data().date.toDate()) === date.value);
    $in(form, '#sclash').textContent = same.length ? `Already planned that day: ${same.map((d) => decodeEntities(d.data().paperTitle)).join('; ')}` : '';
  };
  date.onchange = clash; clash();
  $in(form, '#spres').value = old ? old.presenterName : me;
  $in(form, '#scoord').value = old ? old.coordinatorName || '' : '';
  $in(form, '#steams').value = old ? old.teamsUrl || '' : '';

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!paper) { msg.textContent = 'Pick a paper from the list.'; return; }
    const teams = $in(form, '#steams').value.trim();
    if (teams && !safeUrl(teams)) { msg.textContent = 'The Teams link must start with https://'; return; }
    const pres = $in(form, '#spres').value.trim(); const coord = $in(form, '#scoord').value.trim();
    const when = Timestamp.fromDate(new Date(`${date.value}T00:00:00`));
    const plan = {
      date: when, paperId: paper.id, paperTitle: paper.title,
      presenterUid: people.get(pres) || '', presenterName: pres, coordinatorUid: people.get(coord) || '', coordinatorName: coord,
    };
    msg.textContent = 'Saving…';
    try {
      const b = writeBatch(c.db);
      const ref = sid ? doc(c.db, 'sessions', sid) : doc(collection(c.db, 'sessions'));
      if (sid) b.update(ref, { ...plan, teamsUrl: teams });
      else b.set(ref, { ...plan, ...(teams ? { teamsUrl: teams } : {}), summary: '', slides: '', createdBy: c.user.uid, createdAt: serverTimestamp() });
      if (old && old.paperId !== paper.id) await setPresented(b, old.paperId, ref.id, null);
      await setPresented(b, paper.id, ref.id, when);
      await b.commit();
      dirtyLibrary();
      location.hash = `#/session/${ref.id}`;
    } catch { msg.textContent = 'Could not save the session.'; }
  };
}

async function deleteSession(snap) {
  const s = snap.data();
  const b = writeBatch(c.db);
  b.delete(snap.ref);
  await setPresented(b, s.paperId, snap.id, null);
  await b.commit();
  dirtyLibrary();
  location.hash = '#/sessions';
}

const sessionUrl = (sid) => `${location.origin}/#/point/${sid}`;
const qrSvg = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };

async function renderSession(sid) {
  const snap = await getDoc(doc(c.db, 'sessions', sid));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/sessions">Sessions</a></p></section>')); return; }
  const s = { id: sid, ...snap.data() };
  const [club, template, pts] = await Promise.all([loadClub(), loadTemplate(), getDocs(collection(c.db, 'sessions', sid, 'points'))]);
  const points = pts.docs.map((d) => d.data());
  const fields = sessionFields(s, template);
  const slides = safeUrl(s.slides);
  const me = c.user.uid;
  const mayFill = isAdmin() || (!s.locked && [s.createdBy, s.presenterUid, s.coordinatorUid].includes(me));
  const page = c.el(`<section class="card"><p><a href="#/sessions">← Sessions</a></p>
    <h1>${c.esc(fmtDate(s.date))}</h1>
    <p><a href="#/paper/${c.esc(s.paperId)}">${c.esc(decodeEntities(s.paperTitle))}</a></p>
    <p class="muted">Presenter: ${c.esc(s.presenterName || '—')}</p>
    ${s.coordinatorName ? `<p class="muted">Coordinator: ${c.esc(s.coordinatorName)}</p>` : ''}
    ${s.locked ? '<p class="muted">Locked: read-only.</p>' : ''}
    <h2>Summary</h2><p class="abstract" id="ssum">${s.summary ? c.esc(s.summary) : '<span class="muted">No summary yet.</span>'}</p>
    <h2>Slides</h2><p>${slides ? `<a href="${c.esc(slides)}" target="_blank" rel="noopener">Open slides</a>` : '<span class="muted">No slides link yet.</span>'}</p>
    <div id="sdisc"></div>
    <h2>Members' points</h2><ul class="list" id="spts"></ul>
    <div id="sqr"></div>
    <span class="actions no-print"><button class="link" id="scopy">Copy as text</button><button class="link" id="sprint">Print / PDF</button></span>
    <div id="sedit" class="no-print"></div></section>`);
  c.view.replaceChildren(page);
  if (mayPlanSession(s)) $in(page, '#sedit').before(c.el(`<p class="no-print"><a href="#/plan/-/${c.esc(sid)}">Edit the plan (date, paper, presenter, coordinator)</a></p>`));

  const disc = discussionView(c, fields, s.discussion?.answers);
  if (disc.children.length) { $in(page, '#sdisc').append(c.el('<h2>Discussion</h2>'), disc); }
  const ul = $in(page, '#spts');
  points.forEach((p) => ul.append(c.el(`<li><span>${c.esc(p.text)} <span class="muted">${c.esc(p.name || '')}</span></span></li>`)));
  if (!points.length) ul.append(c.el('<li class="muted">None yet.</li>'));
  if (!s.locked) {
    const link = sessionUrl(sid);
    $in(page, '#sqr').append(c.el(`<div class="no-print"><h3>${c.esc(club.pointPrompt)}</h3>
      <div class="qr" style="max-width:180px" aria-label="QR code">${qrSvg(link)}</div>
      <p><a id="plink" href="#/point/${c.esc(sid)}">Add your point</a></p></div>`));
  }
  $in(page, '#scopy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(sessionMarkdown(s, template, points)); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Copy failed'; }
  };
  $in(page, '#sprint').onclick = () => window.print();

  const host = $in(page, '#sedit');
  if (mayFill) {
    const form = c.el(`<form class="stack"><h2>Edit</h2>
      <label>Summary <textarea id="esum" rows="6" maxlength="8000"></textarea></label>
      <label>Slides link <input id="eslides" type="url" placeholder="https://…" pattern="https://.*"></label>
      <button class="primary">Save</button><p id="emsg" class="muted"></p></form>`);
    $in(form, '#esum').value = s.summary || '';
    $in(form, '#eslides').value = s.slides || '';
    form.onsubmit = async (e) => {
      e.preventDefault();
      const slidesIn = $in(form, '#eslides').value.trim();
      if (slidesIn && !safeUrl(slidesIn)) { $in(form, '#emsg').textContent = 'The slides link must start with https://'; return; }
      try {
        await updateDoc(snap.ref, { summary: $in(form, '#esum').value.trim(), slides: slidesIn });
        renderSession(sid);
      } catch { $in(form, '#emsg').textContent = 'Could not save.'; }
    };
    host.append(form);
    host.append(discussionForm(c, fields, s.discussion?.answers, async (answers) => {
      await updateDoc(snap.ref, { discussion: { fields: snapshot(fields), answers } });
      renderSession(sid);
    }));
  }
  if (isAdmin()) host.append(await adminSessionTools(snap, s, template));
  else if (s.createdBy === me) {
    const del = c.el('<button class="link danger">Delete session</button>');
    del.onclick = async () => { if (confirm('Delete this session?')) await deleteSession(snap); };
    host.append(del);
  }
}

// Admin-only controls on a session: coordinator, start time, Teams link, form override, lock, delete.
async function adminSessionTools(snap, s, template) {
  const ms = await getDocs(collection(c.db, 'members'));
  const members = ms.docs.map((d) => ({ uid: d.id, name: d.data().name || d.data().email }));
  const box = c.el(`<div class="stack"><form class="stack" id="atools"><h2>Admin</h2>
    <label>Coordinator <input id="acoord" list="amembers" maxlength="120" placeholder="Pick a member or type a name"></label>
    <datalist id="amembers">${members.map((m) => `<option value="${c.esc(m.name)}">`).join('')}</datalist>
    <label>Start time <input id="atime" type="time"></label>
    <label>Teams link for this session <input id="ateams" type="url" placeholder="https://… (blank = standing link)" pattern="https://.*"></label>
    <label><input id="alock" type="checkbox"> Locked (only admins edit)</label>
    <button class="primary">Save</button><p class="muted" id="amsg"></p></form>
    <details><summary>Discussion form for this session only</summary><div id="aform"></div></details></div>`);
  $in(box, '#acoord').value = s.coordinatorName || '';
  $in(box, '#atime').value = s.time || '';
  $in(box, '#ateams').value = s.teamsUrl || '';
  $in(box, '#alock').checked = !!s.locked;
  $in(box, '#atools').onsubmit = async (e) => {
    e.preventDefault();
    const name = $in(box, '#acoord').value.trim();
    const hit = members.find((m) => m.name === name);
    const url = $in(box, '#ateams').value.trim();
    if (url && !safeUrl(url)) { $in(box, '#amsg').textContent = 'The Teams link must start with https://'; return; }
    try {
      await updateDoc(snap.ref, { coordinatorName: name, coordinatorUid: hit ? hit.uid : '', time: $in(box, '#atime').value,
        teamsUrl: url, locked: $in(box, '#alock').checked });
      renderSession(snap.id);
    } catch { $in(box, '#amsg').textContent = 'Could not save.'; }
  };
  $in(box, '#aform').append(fieldEditor(c, sessionFields(s, template), async (fields) => {
    await updateDoc(snap.ref, { template: fields });
  }, 'Save for this session'));
  const del = c.el('<button class="link danger">Delete session</button>');
  del.onclick = async () => { if (confirm('Delete this session?')) await deleteSession(snap); };
  box.append(del);
  return box;
}

// One-box form: each member gets one take-home point per session and can edit it.
async function renderPoint(sid) {
  const [snap, club] = await Promise.all([getDoc(doc(c.db, 'sessions', sid)), loadClub()]);
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/sessions">Sessions</a></p></section>')); return; }
  const s = snap.data();
  const ref = doc(c.db, 'sessions', sid, 'points', c.user.uid);
  const mine = await getDoc(ref);
  const page = c.el(`<section class="card"><p><a href="#/session/${c.esc(sid)}">← Session</a></p><h1>${c.esc(club.pointPrompt)}</h1>
    <p class="muted">${c.esc(decodeEntities(s.paperTitle))}</p>
    ${s.locked ? '<p class="muted">This session is locked.</p>' : `<form class="stack"><label>${c.esc(club.pointPrompt)}
      <textarea id="ptext" rows="4" maxlength="500" required></textarea></label>
      <button class="primary">Save</button><p class="muted" id="pmsg"></p></form>`}</section>`);
  c.view.replaceChildren(page);
  const form = $in(page, 'form');
  if (!form) return;
  if (mine.exists()) $in(form, '#ptext').value = mine.data().text;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await setDoc(ref, { text: $in(form, '#ptext').value.trim(), name: c.member.name || c.user.email, updatedAt: serverTimestamp() });
      $in(form, '#pmsg').textContent = 'Saved. You can edit it here until the session is locked.';
    } catch { $in(form, '#pmsg').textContent = 'Could not save.'; }
  };
}
