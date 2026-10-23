// Journal club pages: home (next session), the Plan a session sheet, session pages.
import qrcode from 'qrcode-generator';
import { decodeEntities } from './abstract.js';
import {
  doc, getDoc, getDocs, collection, collectionGroup, setDoc, updateDoc, query, where, orderBy,
  writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

import { dirty as dirtyLibrary, loadLibrary } from './catalogue.js';
import { personIndex } from './people.js';
import {
  DEFAULT_FIELDS, DEFAULT_PROMPT, DEFAULT_TIME, normalizeFields, snapshot, sessionFields, startMillis, inJoinWindow,
  sessionMarkdown, csvExport,
} from './discussion.js';
import { fieldEditor, discussionForm, discussionView } from './discussion-ui.js';

export const CLUB_ROUTES = ['home', 'plan', 'sessions', 'session', 'point'];

let c;              // { db, user, member, view, el, esc } for the current render

const $in = (root, sel) => root.querySelector(sel);
const isAdmin = () => c.member.role === 'admin';
const startTimeText = (s, club) => new Date(startMillis(s, club.time)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts) => ts.toDate().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Timestamp.fromDate(d); };
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/.test(u || '') ? u : '');
const MAX_SLIDES = 50 * 1024 * 1024;
const SLIDE_TYPES = '.pdf,.ppt,.pptx,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation';
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function apiFetch(path, init = {}) {
  const token = await c.user.getIdToken();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
}

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
  if (r.name === 'session' && r.arg) return renderSession(r.arg);
  if (r.name === 'point' && r.arg) return renderPoint(r.arg);
  return renderHome();
}

// Club tab (#/home and #/sessions): today's or the next session first (when, your role, your actions), then Plan a session,
// Upcoming and the latest Past sessions (the rest behind Show all).
const PAST_SHOWN = 5;
const daysAway = (s) => Math.round((s.date.toMillis() - startOfToday().toMillis()) / 86400000);
const whenText = (s) => { const n = daysAway(s); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? `In ${n} days` : ''; };
const myRole = (s) => (s.presenterUid === c.user.uid ? 'You present' : s.coordinatorUid === c.user.uid ? 'You coordinate' : '');
const roleBadge = (s) => (myRole(s) ? ` <span class="badge">${myRole(s)}</span>` : '');

async function renderHome() {
  const page = c.el(`<section class="card"><h1>Club</h1>
    <h2>Next session</h2><div id="next"><p class="muted">Loading…</p></div>
    <p class="actions"><a class="button primary" href="#/plan">Plan a session</a></p>
    <h2>Upcoming</h2><ul id="up" class="list"></ul><h2>Past</h2><ul id="past" class="list"></ul><p id="pastmore"></p></section>`);
  c.view.replaceChildren(page);
  const [ss, club] = await Promise.all([getDocs(query(collection(c.db, 'sessions'), orderBy('date'))), loadClub()]);
  if (!page.isConnected) return;
  const today = startOfToday().toMillis();
  const up = $in(page, '#up'); const past = $in(page, '#past');
  let next = null;
  ss.forEach((d) => {
    const s = d.data();
    const li = c.el(`<li class="paper"><a href="#/session/${d.id}">${c.esc(fmtDate(s.date))}</a>
      <a href="#/session/${d.id}" class="plain">${c.esc(decodeEntities(s.paperTitle))}</a><span class="muted">${c.esc(s.presenterName || '')}${s.coordinatorName ? ` · ${c.esc(s.coordinatorName)}` : ''}${roleBadge(s)}</span></li>`);
    if (s.date.toMillis() >= today) { if (!next) next = { id: d.id, ...s }; else up.append(li); } else past.prepend(li);
  });
  if (!up.children.length) up.append(c.el('<li class="muted">None planned.</li>'));
  if (!past.children.length) past.append(c.el('<li class="muted">None yet.</li>'));
  const older = [...past.children].slice(PAST_SHOWN);
  if (older.length) {
    older.forEach((li) => { li.hidden = true; });
    const more = c.el(`<button type="button" class="link">Show all ${past.children.length} past sessions</button>`);
    more.onclick = () => { older.forEach((li) => { li.hidden = false; }); more.remove(); };
    $in(page, '#pastmore').append(more);
  }
  const box = $in(page, '#next');
  if (!next) {
    box.replaceChildren(c.el('<p class="muted">No session planned yet. Plan one below, or open a paper in the Library and tap Plan a session.</p>'));
  } else {
    const mine = await getDoc(doc(c.db, 'sessions', next.id, 'points', c.user.uid)).catch(() => null);
    if (!page.isConnected) return;
    const hasSlides = next.slidesFile?.kind || safeUrl(next.slides);
    const when = [whenText(next), startTimeText(next, club), next.venue || next.location].filter(Boolean).join(' · ');
    const edit = mayPlanSession(next)
      ? `<a href="#/plan/-/${next.id}">${myRole(next) === 'You present' && !hasSlides ? 'Add slides' : 'Edit session'}</a>` : '';
    box.replaceChildren(c.el(`<p class="next"><a id="nexts" href="#/session/${next.id}"><strong>${c.esc(fmtDate(next.date))}</strong></a>${roleBadge(next)}<br>
        <span class="when">${c.esc(when)}</span><br>
        <a href="#/session/${next.id}">${c.esc(decodeEntities(next.paperTitle))}</a><br><span class="muted">Presenter: ${c.esc(next.presenterName || '—')}${next.coordinatorName ? ` · Coordinator: ${c.esc(next.coordinatorName)}` : ''}</span></p>`),
      c.el(`<p class="actions">${next.locked ? '' : `<a href="#/point/${next.id}">${mine?.exists() ? 'Edit your take-home point' : 'Add take-home point'}</a>`}
        ${hasSlides ? `<a href="#/session/${next.id}">Slides</a>` : ''}${edit}</p>`));
    const url = safeUrl(next.teamsUrl || club.teamsUrl);
    if (url && inJoinWindow(startMillis(next, club.time), Date.now())) {
      box.prepend(c.el(`<p><a class="button primary" id="join" href="${c.esc(url)}" target="_blank" rel="noopener">Join on Teams</a></p>`));
    }
  }
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
  b.update(ref, { presented: list, changedAt: serverTimestamp() }); // changedAt: the library's catalogue picks it up
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

// One quick sheet for planning a session: date, paper by search-as-you-type, presenter, coordinator, optional Teams link.
// Any member may plan; `#/plan/<paper>` opens it with that paper chosen. `#/plan/-/<sid>` is the session's Edit page:
// the same sheet, then the summary, slides, discussion and (admins) the session settings, all saved by one Save bar.
async function renderPlan(paperId, sid) {
  const oldSnap = sid ? await getDoc(doc(c.db, 'sessions', sid)) : null;
  if (sid && !oldSnap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/home">Club</a></p></section>')); return; }
  const old = oldSnap ? oldSnap.data() : null;
  if (old && !mayPlanSession(old)) {
    c.view.replaceChildren(c.el(`<section class="card"><h1>Not allowed</h1><p>Only the person who planned this session, its presenter, its coordinator or an admin can change it.</p><p><a href="#/session/${c.esc(sid)}">Back to the session</a></p></section>`));
    return;
  }
  // The library's cached catalogue (src/catalogue.js), not a fresh read of every paper.
  const [lib, ss, club] = await Promise.all([loadLibrary(c.db), getDocs(collection(c.db, 'sessions')), loadClub()]);
  const papers = [...lib.papers].map(([id, p]) => ({ id, title: p.title, hay: `${p.title} ${(p.authors || []).join(' ')} ${p.year || ''}`.toLowerCase() }));
  // Names for the pickers: people on earlier sessions, plus the whole member list for admins (members can't list it).
  const people = new Map();
  const note = (name, uid) => { if (name && (uid || !people.has(name))) people.set(name, uid || ''); };
  ss.forEach((d) => { const x = d.data(); note(x.presenterName, x.presenterUid); note(x.coordinatorName, x.coordinatorUid); });
  const me = c.member.name || c.user.displayName || c.user.email;
  note(me, c.user.uid);
  const linked = [...people].map(([name, uid]) => ({ name, uid }));
  linked.push({ name: me, uid: c.user.uid, email: c.user.email });
  if (isAdmin()) (await getDocs(collection(c.db, 'members'))).forEach((d) => {
    note(d.data().name || d.data().email, d.id);
    linked.push({ name: d.data().name, uid: d.id, email: d.data().email });
  });
  const findUid = personIndex(linked);
  let warned = '';

  const page = c.el(`<section class="card"><p><a href="#/${sid ? 'session/' + c.esc(sid) : 'home'}">← ${sid ? 'Back to the session' : 'Club'}</a></p>
    <h1>${sid ? 'Edit session' : 'Plan a session'}</h1>
    <form id="pf" class="stack">${sid ? '<h2>Plan</h2>' : ''}
      <label>Date <input id="sdate" type="date" required></label><p id="sclash" class="muted"></p>
      <label>Paper <input id="spaper" type="search" autocomplete="off" placeholder="Search the library by title or author"></label>
      <ul id="spick" class="list"></ul>
      <label>Presenter <input id="spres" list="people" maxlength="120" placeholder="Pick a member or type a name"></label>
      <label>Coordinator <input id="scoord" list="people" maxlength="120" placeholder="Pick a member or type a name"></label>
      <datalist id="people">${[...people.keys()].map((n) => `<option value="${c.esc(n)}">`).join('')}</datalist>
      <label>Teams link for this session (optional) <input id="steams" type="url" placeholder="https://… (blank = standing link)" pattern="https://.*"></label>
      ${sid ? '' : '<button class="primary">Plan session</button><p id="pfmsg" class="muted"></p>'}</form>
    ${sid ? `<div id="sedit" class="stack"></div>
      <div class="savebar no-print" id="savebar"><p id="pfmsg" class="muted" role="status"></p>
        <a href="#/session/${c.esc(sid)}">Done</a><button type="button" class="primary" id="saveall">Save</button></div>` : ''}</section>`);
  c.view.replaceChildren(page);
  const form = $in(page, '#pf'); const msg = $in(page, '#pfmsg');
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

  // The plan fields, or { error } to show instead of saving.
  const readPlan = () => {
    if (!paper) return { error: 'Pick a paper from the list.' };
    const teams = $in(form, '#steams').value.trim();
    if (teams && !safeUrl(teams)) return { error: 'The Teams link must start with https://' };
    const pres = $in(form, '#spres').value.trim(); const coord = $in(form, '#scoord').value.trim();
    const presUid = people.get(pres) || findUid(pres);
    // A presenter not linked to a member can add a point but not the summary, slides or discussion: say so once.
    if (pres && !presUid && warned !== pres) {
      warned = pres;
      return { error: `${pres} isn't linked to a member account, so they won't be able to edit the summary, slides or discussion. `
        + 'Pick them from the list (or invite them first), or press Save again to keep the name only.' };
    }
    return { data: {
      date: Timestamp.fromDate(new Date(`${date.value}T00:00:00`)), paperId: paper.id, paperTitle: paper.title,
      presenterUid: presUid, presenterName: pres, coordinatorUid: people.get(coord) || findUid(coord), coordinatorName: coord, teamsUrl: teams,
    } };
  };

  if (!sid) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const r = readPlan();
      if (r.error) { msg.textContent = r.error; return; }
      const { teamsUrl, ...plan } = r.data;
      msg.textContent = 'Saving…';
      try {
        const b = writeBatch(c.db);
        const ref = doc(collection(c.db, 'sessions'));
        b.set(ref, { ...plan, ...(teamsUrl ? { teamsUrl } : {}), summary: '', slides: '', createdBy: c.user.uid, createdAt: serverTimestamp() });
        await setPresented(b, paper.id, ref.id, plan.date);
        await b.commit();
        dirtyLibrary();
        location.hash = `#/session/${ref.id}`;
      } catch { msg.textContent = 'Could not save the session.'; }
    };
    return;
  }

  // Edit page: each section reports its changes; the Save bar writes the changed sections in one batch.
  const readers = { plan: readPlan };
  const dirty = new Set();
  const track = (name, node) => {
    const mark = () => { dirty.add(name); msg.textContent = 'Unsaved changes'; };
    node.addEventListener('input', mark); node.addEventListener('change', mark);
  };
  const save = async () => {
    if (!dirty.size) { msg.textContent = 'No changes to save.'; return true; }
    const update = {};
    for (const name of dirty) {
      const r = readers[name]();
      if (r.error) { msg.textContent = r.error; return false; }
      Object.assign(update, r.data);
    }
    msg.textContent = 'Saving…';
    try {
      const b = writeBatch(c.db);
      b.update(oldSnap.ref, update);
      if (dirty.has('plan')) {
        if (old.paperId !== update.paperId) await setPresented(b, old.paperId, sid, null);
        await setPresented(b, update.paperId, sid, update.date);
      }
      await b.commit();
      if (dirty.has('plan')) dirtyLibrary();
      Object.assign(old, update);
      dirty.clear();
      msg.textContent = 'Saved.';
      return true;
    } catch { msg.textContent = 'Could not save the session.'; return false; }
  };
  guardLeaving(() => dirty.size > 0);
  track('plan', form);
  form.onsubmit = (e) => { e.preventDefault(); save(); };
  $in(page, '#saveall').onclick = () => save();
  // Slides and the session's own discussion form save on their own and redraw the page: keep other edits first.
  const reload = async () => {
    if (dirty.size && !(await save()) && !confirm('Your other changes could not be saved. Reload the page and lose them?')) return;
    renderPlan('', sid);
  };
  await editSections(oldSnap, $in(page, '#sedit'), { readers, track, save, reload });
}

// The rest of the Edit page: summary, slides, discussion, then admin settings and delete.
async function editSections(snap, host, { readers, track, save, reload }) {
  const sid = snap.id;
  const s = { id: sid, ...snap.data() };
  const template = await loadTemplate();
  const fields = sessionFields(s, template);
  const sf = s.slidesFile?.kind ? s.slidesFile : null;
  const section = (name, node, read) => {
    readers[name] = read; track(name, node);
    node.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    return node;
  };
  const sum = c.el(`<form class="stack" id="sumform"><h2>Summary</h2>
    <label>Summary <textarea id="esum" rows="6" maxlength="8000"></textarea></label></form>`);
  $in(sum, '#esum').value = s.summary || '';
  host.append(section('summary', sum, () => ({ data: { summary: $in(sum, '#esum').value.trim() } })), slidesForm(snap, sf, reload));
  const disc = discussionForm(c, fields, s.discussion?.answers);
  host.append(section('discussion', disc, () => {
    const { answers, missing } = disc.read();
    return missing.length ? { error: `Please fill in: ${missing.join(', ')}` } : { data: { discussion: { fields: snapshot(fields), answers } } };
  }));
  if (isAdmin()) host.append(adminSessionTools(snap, s, template, reload, section));
  if (isAdmin() || s.createdBy === c.user.uid) {
    const del = c.el('<button class="link danger">Delete session</button>');
    del.onclick = async () => { if (confirm('Delete this session?')) await deleteSession(snap); };
    host.append(del);
  }
}

// While the Edit page has unsaved changes, ask before leaving it by a link or closing the tab.
let unsaved = () => false;
function guardLeaving(check) {
  if (!guardLeaving.on) {
    guardLeaving.on = true;
    window.addEventListener('beforeunload', (e) => { if (unsaved()) e.preventDefault(); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href^="#"]');
      if (a && unsaved() && !confirm('Leave without saving your changes?')) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/plan/-/')) unsaved = () => false; });
  }
  unsaved = check;
}

async function deleteSession(snap) {
  const s = snap.data();
  if (s.slidesFile?.kind) await apiFetch(`/api/slides/${snap.id}`, { method: 'DELETE' }).catch(() => {});
  const b = writeBatch(c.db);
  b.delete(snap.ref);
  await setPresented(b, s.paperId, snap.id, null);
  await b.commit();
  dirtyLibrary();
  location.hash = '#/home';
}

const sessionUrl = (sid) => `${location.origin}/#/point/${sid}`;
const qrSvg = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); };

async function renderSession(sid) {
  const snap = await getDoc(doc(c.db, 'sessions', sid));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/home">Club</a></p></section>')); return; }
  const s = { id: sid, ...snap.data() };
  const [club, template, pts] = await Promise.all([loadClub(), loadTemplate(), getDocs(collection(c.db, 'sessions', sid, 'points'))]);
  const points = pts.docs.map((d) => ({ ...d.data(), mine: d.id === c.user.uid }));
  const myPoint = points.some((p) => p.mine);
  const fields = sessionFields(s, template);
  const slides = safeUrl(s.slides);
  const sf = s.slidesFile?.kind ? s.slidesFile : null;
  const slidesHtml = sf
    ? `${sf.pdf ? '<button class="link" id="spdf">Open PDF</button>' : ''}${sf.kind !== 'pdf' ? '<button class="link" id="sorig">Download PowerPoint</button>' : ''}
       <span class="muted">${c.esc(sf.name || '')} · ${fmtSize(sf.size || 0)}${sf.kind !== 'pdf' && !sf.pdf ? ' · no PDF copy' : ''}</span>`
    : slides ? `<a href="${c.esc(slides)}" target="_blank" rel="noopener">Open slides</a>` : '<span class="muted">No slides yet.</span>';
  document.title = `Session ${fmtDate(s.date)} · Journal club`;
  const paperSnap = s.paperId ? await getDoc(doc(c.db, 'papers', s.paperId)).catch(() => null) : null;
  const paper = paperSnap?.exists() ? paperSnap.data() : null;
  const pmeta = paper ? [paper.journal, paper.year].filter(Boolean).join(' · ') : '';
  const short = paper?.abstract ? decodeEntities(paper.abstract).replace(/\s+/g, ' ').slice(0, 220).replace(/\s+\S*$/, '') + (paper.abstract.length > 220 ? '…' : '') : '';
  const venue = s.venue || s.location || '';
  const page = c.el(`<section class="card sessionpage"><p class="eyebrow">SESSION</p><p class="back"><a href="#/home">← Club</a></p>
    <div class="session-head"><h1>${c.esc(fmtDate(s.date))}</h1>
    <p class="muted">${c.esc(startTimeText(s, club))}${venue ? ` · ${c.esc(venue)}` : ''}</p>
    <p>Presenter: ${c.esc(s.presenterName || '—')}${s.coordinatorName ? `<br>Coordinator: ${c.esc(s.coordinatorName)}` : ''}</p>
    ${s.locked ? '<p class="muted">Locked: read-only.</p>' : ''}
    <p class="actions no-print" id="sacts"></p></div>
    <div class="paper-card" id="spaper"><p class="eyebrow">PAPER</p><p><strong>${c.esc(decodeEntities(s.paperTitle))}</strong></p>
      ${pmeta ? `<p class="muted">${c.esc(pmeta)}</p>` : ''}${short ? `<p>${c.esc(short)}</p>` : ''}
      ${s.paperId ? `<p><a class="button" id="openpaper" href="#/paper/${c.esc(s.paperId)}">Open paper</a></p>` : ''}</div>
    <h2>Summary</h2><p class="abstract" id="ssum">${s.summary ? c.esc(s.summary) : '<span class="muted">No summary yet.</span>'}</p>
    <h2>Slides</h2><p id="sslides">${slidesHtml}</p>
    <div id="sdisc"></div>
    <h2>Members' points</h2><ul class="list" id="spts"></ul>
    <div id="sqr"></div>
    <span class="actions no-print"><button class="link" id="scopy">Copy as text</button><button class="link" id="sprint">Print / PDF</button></span>
    ${mayPlanSession(s) ? `<p class="no-print"><a class="button primary" href="#/plan/-/${c.esc(sid)}">Edit session</a></p>` : ''}</section>`);
  c.view.replaceChildren(page);

  const disc = discussionView(c, fields, s.discussion?.answers);
  if (disc.children.length) { $in(page, '#sdisc').append(c.el('<h2>Discussion</h2>'), disc); }
  const ul = $in(page, '#spts');
  points.forEach((p) => ul.append(c.el(`<li><span>${c.esc(p.text)} <span class="muted">${c.esc(p.name || '')}${p.mine ? ' (you)' : ''}</span></span></li>`)));
  if (!points.length) ul.append(c.el('<li class="muted">None yet.</li>'));
  // Join on Teams (in its window) and your point sit under the session's details, not at the foot of the page.
  const acts = $in(page, '#sacts');
  const url = safeUrl(s.teamsUrl || club.teamsUrl);
  if (url && inJoinWindow(startMillis(s, club.time), Date.now())) {
    acts.append(c.el(`<a class="button primary" id="join" href="${c.esc(url)}" target="_blank" rel="noopener">Join on Teams</a>`));
  }
  if (!s.locked) {
    acts.append(c.el(`<a class="button" id="plink" href="#/point/${c.esc(sid)}">${myPoint ? 'Edit your point' : 'Add your point'}</a>`));
    $in(page, '#sqr').append(c.el(`<div class="no-print"><h3>${c.esc(club.pointPrompt)}</h3>
      <p class="muted">Scan to add a point from your phone.</p>
      <div class="qr" style="max-width:180px" aria-label="QR code">${qrSvg(sessionUrl(sid))}</div></div>`));
  }
  $in(page, '#scopy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(sessionMarkdown(s, template, points)); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Copy failed'; }
  };
  $in(page, '#sprint').onclick = () => window.print();
  if (sf?.pdf) $in(page, '#spdf').onclick = () => openSlides(sid, 'pdf', sf.name);
  if (sf && sf.kind !== 'pdf') $in(page, '#sorig').onclick = () => openSlides(sid, 'original', sf.name);

}

// PDF opens in a new tab; PowerPoint downloads under its own name.
async function openSlides(sid, which, name) {
  const w = which === 'pdf' ? window.open('', '_blank') : null; // opened before the await so pop-up blockers allow it
  const r = await apiFetch(`/api/slides/${sid}/${which}`);
  if (!r.ok) { w?.close(); alert('Could not open the slides.'); return; }
  const url = URL.createObjectURL(await r.blob());
  if (which === 'pdf') { if (w) w.location.href = url; else location.href = url; return; }
  const a = document.createElement('a');
  a.href = url; a.download = name || 'slides.pptx';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Upload a PDF or PowerPoint, or pull one from a share link; the Worker keeps a copy (and a PDF of PowerPoint).
function slidesForm(snap, sf, done) {
  const sid = snap.id;
  const form = c.el(`<form class="stack" id="slidesform"><h2>Slides</h2><p class="muted" id="scur">${sf ? `${c.esc(sf.name || '')} · ${fmtSize(sf.size || 0)}` : 'No slides yet.'}</p>
    <label>Upload slides (PDF or PowerPoint) <input type="file" id="sfile" accept="${SLIDE_TYPES}"></label>
    <label>Or pull from a link <input id="surl" type="url" placeholder="Google Slides, OneDrive, Dropbox or Drive link"></label>
    <p class="muted">A link works only if it is shared as "Anyone with the link can view"; the file is copied here. PowerPoint is also saved as a PDF.</p>
    <button class="primary">${sf ? 'Replace slides' : 'Add slides'}</button>
    ${sf ? '<button type="button" class="link danger" id="sremove">Remove slides</button>' : ''}
    <p id="smsg" class="muted" role="status"></p></form>`);
  const msg = $in(form, '#smsg');
  const btn = form.querySelector('button.primary');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const file = $in(form, '#sfile').files[0];
    const link = $in(form, '#surl').value.trim();
    if (!file && !link) { msg.textContent = 'Choose a file or paste a link.'; return; }
    if (file && file.size > MAX_SLIDES) { msg.textContent = 'Slides are over 50 MB.'; return; }
    if (!file && !safeUrl(link)) { msg.textContent = 'The link must start with https://'; return; }
    btn.disabled = true;
    msg.textContent = file ? 'Uploading… a PowerPoint takes up to a minute to turn into a PDF.' : 'Pulling the slides from the link…';
    try {
      const r = file
        ? await apiFetch(`/api/slides/${sid}`, { method: 'PUT', body: file, headers: { 'X-File-Name': encodeURIComponent(file.name) } })
        : await apiFetch(`/api/slides/${sid}`, { method: 'POST', body: JSON.stringify({ url: link }), headers: { 'Content-Type': 'application/json' } });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = out.error || 'Could not save the slides.'; btn.disabled = false; return; }
      await updateDoc(snap.ref, { slidesFile: { name: out.name, size: out.size, kind: out.kind, pdf: out.pdf }, slides: '' });
      if (out.warning) alert(out.warning);
      done();
    } catch { msg.textContent = 'Could not save the slides.'; btn.disabled = false; }
  };
  if (sf) {
    $in(form, '#sremove').onclick = async () => {
      if (!confirm('Remove the slides?')) return;
      const r = await apiFetch(`/api/slides/${sid}`, { method: 'DELETE' }).catch(() => null);
      if (!r?.ok) { msg.textContent = 'Could not remove the slides.'; return; }
      await updateDoc(snap.ref, { slidesFile: {} });
      done();
    };
  }
  return form;
}

// Admin-only settings on a session: start time and lock (saved by the Save bar), and the discussion form for this
// session only (saved on its own, since it reshapes the Discussion section).
function adminSessionTools(snap, s, template, done, section) {
  const box = c.el(`<div class="stack"><form class="stack" id="atools"><h2>Admin</h2>
    <label>Start time <input id="atime" type="time"></label>
    <label><input id="alock" type="checkbox"> Locked (only admins edit)</label><p class="muted" id="amsg"></p></form>
    <details ${s.template?.length ? 'open' : ''}><summary>Discussion form for this session only</summary>
      <p class="muted">${s.template?.length ? 'This session has its own form.' : s.discussion?.fields?.length
        ? 'This session keeps the form its discussion was filled with; changes to the default form don\'t reach it.' : 'This session follows the default form.'}</p>
      <p><button type="button" class="link" id="adefault">Use the default form</button></p>
      <div id="aform"></div></details></div>`);
  $in(box, '#atime').value = s.time || '';
  $in(box, '#alock').checked = !!s.locked;
  section('admin', $in(box, '#atools'), () => ({ data: { time: $in(box, '#atime').value, locked: $in(box, '#alock').checked } }));
  $in(box, '#adefault').onclick = async () => {
    try { await updateDoc(snap.ref, { template }); done(); } catch { $in(box, '#amsg').textContent = 'Could not save.'; }
  };
  $in(box, '#aform').append(fieldEditor(c, sessionFields(s, template), async (fields) => {
    await updateDoc(snap.ref, { template: fields });
    done();
  }, 'Save for this session'));
  return box;
}

// One-box form: each member gets one take-home point per session and can edit it.
async function renderPoint(sid) {
  const [snap, club] = await Promise.all([getDoc(doc(c.db, 'sessions', sid)), loadClub()]);
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/home">Club</a></p></section>')); return; }
  const s = snap.data();
  const ref = doc(c.db, 'sessions', sid, 'points', c.user.uid);
  const mine = await getDoc(ref);
  const page = c.el(`<section class="card"><p><a href="#/session/${c.esc(sid)}">← Session</a></p><h1>${c.esc(club.pointPrompt)}</h1>
    <p class="muted">${c.esc(decodeEntities(s.paperTitle))}</p>
    ${s.locked ? '<p class="muted">This session is locked.</p>' : `<form class="stack"><label>${c.esc(club.pointPrompt)}
      <textarea id="ptext" rows="4" maxlength="500" required></textarea></label>
      <button class="primary">${mine.exists() ? 'Update' : 'Save'}</button><p class="muted" id="pmsg" role="status"></p></form>`}</section>`);
  c.view.replaceChildren(page);
  const form = $in(page, 'form');
  if (!form) return;
  if (mine.exists()) $in(form, '#ptext').value = mine.data().text;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await setDoc(ref, { text: $in(form, '#ptext').value.trim(), name: c.member.name || c.user.email, updatedAt: serverTimestamp() });
      $in(form, '#pmsg').replaceChildren('Saved. You can edit it here until the session is locked. ',
        c.el(`<a href="#/session/${c.esc(sid)}">Back to the session</a>`));
      $in(form, 'button').textContent = 'Update';
    } catch { $in(form, '#pmsg').textContent = 'Could not save.'; }
  };
}
