// Journal club pages: home (next session), voting on library papers, presenter rota, session pages.
import {
  doc, getDoc, getDocs, collection, collectionGroup, setDoc, deleteDoc, updateDoc, query, where, orderBy,
  limit, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

export const CLUB_ROUTES = ['home', 'vote', 'rota', 'sessions', 'session'];

let c;              // { db, user, member, view, el, esc } for the current render

const $in = (root, sel) => root.querySelector(sel);
const isAdmin = () => c.member.role === 'admin';
const fmtDate = (ts) => ts.toDate().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return Timestamp.fromDate(d); };
const safeUrl = (u) => (/^https:\/\/[^\s"<>]+$/.test(u || '') ? u : '');
const rotaRef = () => doc(c.db, 'rota', 'main');

export function renderClubRoute(r, ctx) {
  c = ctx;
  if (r.name === 'vote') return renderVote();
  if (r.name === 'rota') return renderRota();
  if (r.name === 'sessions') return renderSessions();
  if (r.name === 'session' && r.arg) return renderSession(r.arg);
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
    .map((d) => ({ id: d.id, title: d.data().title, year: d.data().year, votes: counts.get(d.id) || 0, mine: mine.has(d.id) }))
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
  const [next, papers] = await Promise.all([nextSession(), tally()]);
  $in(page, '#next').replaceChildren(next
    ? c.el(`<p class="next"><a href="#/session/${next.id}"><strong>${c.esc(fmtDate(next.date))}</strong></a><br>
        ${c.esc(next.paperTitle)}<br><span class="muted">Presenter: ${c.esc(next.presenterName || '—')}</span></p>`)
    : c.el('<p class="muted">No session planned yet.</p>'));
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
      <span>${c.esc(s.paperTitle)}</span><span class="muted">${c.esc(s.presenterName || '')}</span></li>`);
    if (s.date.toMillis() >= today) up.append(li); else past.prepend(li);
  });
  if (!up.children.length) up.append(c.el('<li class="muted">None planned.</li>'));
  if (!past.children.length) past.append(c.el('<li class="muted">None yet.</li>'));
  if (isAdmin()) renderNewSession($in(page, '#snew'));
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

async function renderSession(sid) {
  const snap = await getDoc(doc(c.db, 'sessions', sid));
  if (!snap.exists()) { c.view.replaceChildren(c.el('<section class="card"><h1>Not found</h1><p><a href="#/sessions">Sessions</a></p></section>')); return; }
  const s = snap.data();
  const slides = safeUrl(s.slides);
  const page = c.el(`<section class="card"><p><a href="#/sessions">← Sessions</a></p>
    <h1>${c.esc(fmtDate(s.date))}</h1>
    <p><a href="#/paper/${c.esc(s.paperId)}">${c.esc(s.paperTitle)}</a></p>
    <p class="muted">Presenter: ${c.esc(s.presenterName || '—')}</p>
    <h2>Summary</h2><p class="abstract" id="ssum">${s.summary ? c.esc(s.summary) : '<span class="muted">No summary yet.</span>'}</p>
    <h2>Slides</h2><p>${slides ? `<a href="${c.esc(slides)}" target="_blank" rel="noopener">Open slides</a>` : '<span class="muted">No slides link yet.</span>'}</p>
    <div id="sedit"></div></section>`);
  c.view.replaceChildren(page);
  if (!isAdmin() && s.presenterUid !== c.user.uid) return;
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
  $in(page, '#sedit').append(form);
  if (isAdmin()) {
    const del = c.el('<button class="link danger">Delete session</button>');
    del.onclick = async () => { if (confirm('Delete this session?')) { await deleteDoc(snap.ref); location.hash = '#/sessions'; } };
    $in(page, '#sedit').append(del);
  }
}
