// Journal club pages: home (next session), voting on library papers, presenter rota, session pages.
import qrcode from 'qrcode-generator';
import { decodeEntities } from './abstract.js';
import {
  doc, getDoc, getDocs, collection, collectionGroup, setDoc, deleteDoc, updateDoc, query, where, orderBy,
  limit, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

import {
  DEFAULT_FIELDS, DEFAULT_PROMPT, DEFAULT_TIME, normalizeFields, snapshot, sessionFields, startMillis, inJoinWindow,
  sessionMarkdown, csvExport,
} from './discussion.js';
import { fieldEditor, discussionForm, discussionView } from './discussion-ui.js';

export const CLUB_ROUTES = ['home', 'vote', 'rota', 'sessions', 'session', 'point'];

let c;              // { db, user, member, view, el, esc } for the current render

const $in = (root, sel) => root.querySelector(sel);
const isAdmin = () => c.member.role === 'admin';
const fmtDate = (ts) => ts.toDate().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Timestamp.fromDate(d); };
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/.test(u || '') ? u : '');
const rotaRef = () => doc(c.db, 'rota', 'main');

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
  if (r.name === 'vote') return renderVote();
  if (r.name === 'rota') return renderRota();
  if (r.name === 'sessions') return renderSessions();
  if (r.name === 'session' && r.arg) return renderSession(r.arg);
  if (r.name === 'point' && r.arg) return renderPoint(r.arg);
  return renderHome();
}

// Papers with their vote counts, most votes first; papers already presented drop out.
async function tally() {
  const [ps, vs, ss] = await Promise.all([
    getDocs(collection(c.db, 'papers')), getDocs(collectionGroup(c.db, 'votes')), getDocs(collection(c.db, 'sessions')),
  ]);
  const done = new Set(ss.docs.map((d) => d.data().paperId));
  const counts = new Map(); const mine = new Set();
  vs.forEach((d) => {
    const pid = d.ref.parent.parent.id;
    counts.set(pid, (counts.get(pid) || 0) + 1);
    if (d.id === c.user.uid) mine.add(pid);
  });
  return ps.docs.filter((d) => !done.has(d.id))
    .map((d) => ({ id: d.id, title: decodeEntities(d.data().title), year: d.data().year, votes: counts.get(d.id) || 0, mine: mine.has(d.id) }))
    .sort((a, b) => b.votes - a.votes || a.title.localeCompare(b.title));
}

async function nextSession() {
  const s = await getDocs(query(collection(c.db, 'sessions'), where('date', '>=', startOfToday()), orderBy('date'), limit(1)));
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}

async function renderHome() {
  const page = c.el(`<section class="card"><h1>Journal Club</h1>
    <h2>Next session</h2><div id="next"><p class="muted">Loading…</p></div>
    <h2>Most wanted papers</h2><ol id="top" class="list"></ol>
    <p class="actions"><a href="#/vote">Vote</a> <a href="#/sessions">All sessions</a> <a href="#/rota">Rota</a> <a href="#/library">Library</a></p></section>`);
  c.view.replaceChildren(page);
  const [next, papers, club] = await Promise.all([nextSession(), tally(), loadClub()]);
  $in(page, '#next').replaceChildren(next
    ? c.el(`<p class="next"><a href="#/session/${next.id}"><strong>${c.esc(fmtDate(next.date))}</strong></a><br>
        ${c.esc(next.paperTitle)}<br><span class="muted">Presenter: ${c.esc(next.presenterName || '—')}${next.coordinatorName ? ` · Coordinator: ${c.esc(next.coordinatorName)}` : ''}</span></p>`)
    : c.el('<p class="muted">No session planned yet.</p>'));
  const url = next && safeUrl(next.teamsUrl || club.teamsUrl);
  if (url && inJoinWindow(startMillis(next, club.time), Date.now())) {
    $in(page, '#next').append(c.el(`<p><a class="button primary" id="join" href="${c.esc(url)}" target="_blank" rel="noopener">Join on Teams</a></p>`));
  }
  const top = $in(page, '#top');
  const voted = papers.filter((p) => p.votes).slice(0, 3);
  voted.forEach((p) => top.append(c.el(`<li><a href="#/paper/${p.id}">${c.esc(p.title)}</a><span class="muted">${p.votes} ${p.votes === 1 ? 'vote' : 'votes'}</span></li>`)));
  if (!voted.length) top.append(c.el('<li class="muted">No votes yet.</li>'));
}

async function renderVote() {
  const page = c.el(`<section class="card"><h1>Vote</h1>
    <p class="muted">One vote per paper. The most-voted papers are picked for the next sessions.</p>
    <ul id="vl" class="list"><li class="muted">Loading…</li></ul></section>`);
  c.view.replaceChildren(page);
  const list = $in(page, '#vl');
  const show = async () => {
    const papers = await tally();
    list.replaceChildren();
    if (!papers.length) list.append(c.el('<li class="muted">No papers to vote on. <a href="#/add">Add one</a>.</li>'));
    papers.forEach((p) => {
      const li = c.el(`<li class="vote"><span><a href="#/paper/${p.id}">${c.esc(p.title)}</a> <span class="muted">${c.esc(p.year || '')}</span></span>
        <span class="count" aria-label="${p.votes} votes">${p.votes}</span></li>`);
      const b = c.el(`<button class="${p.mine ? 'link' : 'primary'}" aria-pressed="${p.mine}">${p.mine ? 'Voted · undo' : 'Vote'}</button>`);
      b.setAttribute('aria-label', `${p.mine ? 'Remove vote for' : 'Vote for'} ${p.title}`);
      b.onclick = async () => {
        b.disabled = true;
        const ref = doc(c.db, 'papers', p.id, 'votes', c.user.uid);
        try { await (p.mine ? deleteDoc(ref) : setDoc(ref, { at: serverTimestamp() })); }
        catch { alert('Could not save the vote.'); }
        show();
      };
      li.append(b); list.append(li);
    });
  };
  show();
}

async function loadRota() {
  const s = await getDoc(rotaRef());
  return s.exists() ? s.data() : { order: [], next: 0 };
}
const saveRota = (order, next) => setDoc(rotaRef(), {
  order, next: order.length ? next % order.length : 0, updatedBy: c.user.uid, updatedAt: serverTimestamp(),
});

async function renderRota() {
  const page = c.el(`<section class="card"><h1>Presenter rota</h1>
    <p class="muted">Presenters take turns in this order; the arrow marks who is up next.</p>
    <ol id="rl" class="list"><li class="muted">Loading…</li></ol><div id="radmin"></div></section>`);
  c.view.replaceChildren(page);
  const show = async () => {
    const rota = await loadRota();
    const list = $in(page, '#rl'); list.replaceChildren();
    if (!rota.order.length) list.append(c.el('<li class="muted">No rota yet.</li>'));
    rota.order.forEach((p, i) => {
      const li = c.el(`<li><span>${i === rota.next ? '→ ' : ''}${c.esc(p.name)}${i === rota.next ? ' <span class="muted">(next)</span>' : ''}</span></li>`);
      if (isAdmin()) {
        const move = (to) => async () => {
          const o = [...rota.order]; [o[i], o[to]] = [o[to], o[i]];
          await saveRota(o, rota.next); show();
        };
        if (i > 0) { const up = c.el(`<button class="link" aria-label="Move ${c.esc(p.name)} up">↑</button>`); up.onclick = move(i - 1); li.append(up); }
        if (i < rota.order.length - 1) { const dn = c.el(`<button class="link" aria-label="Move ${c.esc(p.name)} down">↓</button>`); dn.onclick = move(i + 1); li.append(dn); }
        if (i !== rota.next) { const nx = c.el('<button class="link">Make next</button>'); nx.onclick = async () => { await saveRota(rota.order, i); show(); }; li.append(nx); }
      }
      list.append(li);
    });
    if (isAdmin()) {
      const b = c.el('<button class="primary">Rebuild from members</button>');
      b.onclick = async () => {
        if (rota.order.length && !confirm('Rebuild the rota from the members list? Order resets to A–Z, keeping no one out.')) return;
        const ms = await getDocs(collection(c.db, 'members'));
        const order = ms.docs.map((d) => ({ uid: d.id, name: d.data().name || d.data().email }))
          .sort((a, b2) => a.name.localeCompare(b2.name));
        await saveRota(order, 0); show();
      };
      $in(page, '#radmin').replaceChildren(b);
    }
  };
  show();
}

async function renderSessions() {
  const page = c.el(`<section class="card"><h1>Sessions</h1><div id="snew"></div>
    <h2>Upcoming</h2><ul id="up" class="list"></ul><h2>Past</h2><ul id="past" class="list"></ul></section>`);
  c.view.replaceChildren(page);
  const ss = await getDocs(query(collection(c.db, 'sessions'), orderBy('date')));
  const today = startOfToday().toMillis();
  const up = $in(page, '#up'); const past = $in(page, '#past');
  ss.forEach((d) => {
    const s = d.data();
    const li = c.el(`<li class="paper"><a href="#/session/${d.id}">${c.esc(fmtDate(s.date))}</a>
      <span>${c.esc(s.paperTitle)}</span><span class="muted">${c.esc(s.presenterName || '')}${s.coordinatorName ? ` · ${c.esc(s.coordinatorName)}` : ''}</span></li>`);
    if (s.date.toMillis() >= today) up.append(li); else past.prepend(li);
  });
  if (!up.children.length) up.append(c.el('<li class="muted">None planned.</li>'));
  if (!past.children.length) past.append(c.el('<li class="muted">None yet.</li>'));
  if (isAdmin()) { renderNewSession($in(page, '#snew')); page.append(exportPanel()); }
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

async function renderNewSession(box) {
  const [papers, rota] = await Promise.all([tally(), loadRota()]);
  const next = rota.order[rota.next];
  const form = c.el(`<form id="sf" class="stack"><h2>Plan a session</h2>
    <label>Date <input id="sdate" type="date" required></label>
    <label>Paper <select id="spaper" required>${papers.map((p) =>
      `<option value="${p.id}">${c.esc(p.title)} (${p.votes})</option>`).join('')}</select></label>
    <label>Presenter <select id="spres">${rota.order.map((p, i) =>
      `<option value="${i}" ${i === rota.next ? 'selected' : ''}>${c.esc(p.name)}</option>`).join('')}</select></label>
    <button class="primary">Create session</button><p id="smsg" class="muted"></p></form>`);
  box.replaceChildren(form);
  if (!papers.length) $in(form, '#smsg').textContent = 'Add papers to the library first.';
  if (!next) $in(form, '#smsg').textContent += ' Build the rota first (Rota page).';
  form.onsubmit = async (e) => {
    e.preventDefault();
    const pid = $in(form, '#spaper').value;
    const pi = Number($in(form, '#spres').value);
    const pres = rota.order[pi];
    const dateStr = $in(form, '#sdate').value;
    if (!pid || !pres || !dateStr) return;
    const b = writeBatch(c.db);
    const ref = doc(collection(c.db, 'sessions'));
    b.set(ref, {
      date: Timestamp.fromDate(new Date(`${dateStr}T00:00:00`)), paperId: pid,
      paperTitle: papers.find((p) => p.id === pid).title, presenterUid: pres.uid, presenterName: pres.name,
      summary: '', slides: '', createdBy: c.user.uid, createdAt: serverTimestamp(),
    });
    // The rota moves on past whoever was just booked.
    b.set(rotaRef(), { order: rota.order, next: (pi + 1) % rota.order.length, updatedBy: c.user.uid, updatedAt: serverTimestamp() });
    try { await b.commit(); location.hash = `#/session/${ref.id}`; }
    catch { $in(form, '#smsg').textContent = 'Could not create the session.'; }
  };
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
  const mayFill = isAdmin() || (!s.locked && (s.presenterUid === me || s.coordinatorUid === me));
  const page = c.el(`<section class="card"><p><a href="#/sessions">← Sessions</a></p>
    <h1>${c.esc(fmtDate(s.date))}</h1>
    <p><a href="#/paper/${c.esc(s.paperId)}">${c.esc(s.paperTitle)}</a></p>
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
  del.onclick = async () => { if (confirm('Delete this session?')) { await deleteDoc(snap.ref); location.hash = '#/sessions'; } };
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
    <p class="muted">${c.esc(s.paperTitle)}</p>
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
