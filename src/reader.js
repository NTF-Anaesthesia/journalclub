// In-app PDF reader: #/read/<paper>/<page>?q=<term> (slides: #/view/<deck_id or sess_id>/<page>). Continuous scroll, pinch or +/- zoom, page jump, the search term
// highlighted, last page remembered per member on this device. The PDF comes from the offline cache when it is there,
// else from the Worker in Range chunks (and is then kept for offline use). Streaming is off on purpose: the plain
// network loader always opens with a small Range request, so only the chunks the first page needs are downloaded.
import './polyfills.js';
import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist';
import { getCached, keep, touch, prune, isOffline } from './offline.js';
import { doc, getDoc, getDocs, collection, query, where, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { loadStarred, setNoted } from './prefs.js';

GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const KEEP_PAGES = 400;
const RANGE_CHUNK = 256 * 1024;

const posKey = (uid) => `jc.read.${uid}`;
export function lastPage(uid, id) {
  try { return Number(JSON.parse(localStorage.getItem(posKey(uid)) || '{}')[id]) || 0; } catch { return 0; }
}
function savePage(uid, id, n) {
  try {
    const all = JSON.parse(localStorage.getItem(posKey(uid)) || '{}');
    delete all[id];
    all[id] = n; // most recent last
    const ids = Object.keys(all);
    ids.slice(0, Math.max(0, ids.length - KEEP_PAGES)).forEach((k) => delete all[k]);
    localStorage.setItem(posKey(uid), JSON.stringify(all));
  } catch { /* storage unavailable */ }
}

// A safe file name from the paper title.
export const fileName = (title) => `${String(title || 'paper').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'paper'}.pdf`;

// Words of the search term worth highlighting (lower case, 2+ letters).
export const termWords = (q) => [...new Set(String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 6);

// #/view/deck_<deck>/<page> and #/view/sess_<session>/<page> open slides the same way (their search keys, see the Worker).
export function readerSource(r) {
  const m = r.name === 'view' ? /^(deck|sess)_(.+)$/.exec(r.arg || '') : null;
  if (!m) return { id: r.arg, file: `/api/file/${r.arg}`, back: `#/paper/${r.arg}`, backText: 'Back to paper', doc: ['papers', r.arg], what: 'paper' };
  const deck = m[1] === 'deck';
  return { id: r.arg, file: `/api/${deck ? 'decks' : 'slides'}/${m[2]}/pdf`, back: deck ? `#/deck/${m[2]}` : `#/session/${m[2]}`,
    backText: deck ? 'Back to the deck' : 'Back to the session', doc: [deck ? 'decks' : 'sessions', m[2]], what: 'slides' };
}

export async function renderReader(r, c, apiFetch) {
  const src = readerSource(r);
  const id = src.id;
  let words = termWords(r.q);
  const page = c.el(`<section class="card reader">
    <div class="reader-head">
      <div class="reader-tools">
        <a href="${c.esc(src.back)}" id="rback" class="rbtn" aria-label="${src.backText}" title="${src.backText}">←</a>
        <h1 class="reader-title" id="rtitle">PDF</h1>
        <label class="reader-jump"><span class="sr-only">Page number</span><input id="pg" type="number" inputmode="numeric" min="1" value="1" aria-label="Page number"><span class="muted">/<span id="pn">…</span></span></label>
        <button type="button" class="rbtn" id="rfind" aria-label="Search in file" aria-expanded="false">🔍</button>
        <button type="button" class="rbtn" id="rnotes" aria-label="Notes" aria-expanded="false" hidden>📝</button>
        <button type="button" class="rbtn" id="zo" aria-label="Zoom out">−</button><button type="button" class="rbtn" id="zi" aria-label="Zoom in">+</button>
        <button type="button" class="rbtn" id="rmore" aria-label="More" aria-expanded="false">⋯</button>
      </div>
      <form class="reader-find" id="rfindbar" hidden>
        <input id="rq" type="search" autocomplete="off" aria-label="Find in this file" placeholder="Find in this file" value="${c.esc(r.q || '')}">
        <span class="muted" id="rcount" aria-live="polite"></span>
        <button type="button" class="rbtn" id="rprev" aria-label="Previous match">↑</button><button type="submit" class="rbtn" id="rnext" aria-label="Next match">↓</button>
      </form>
      <div class="reader-more" id="rmorebar" hidden>
        <a href="#/paper/${c.esc(id)}" id="rsess" hidden>Session</a>
        <span class="badge" id="roff" hidden>Offline copy</span>
        <span class="reader-share" id="rshare" hidden><button type="button" id="rdl">Download</button><button type="button" id="rsend">Send</button></span>
      </div>
    </div>
    <p id="rmsg" class="muted">Opening…</p><div id="pages" class="reader-pages"></div>
    <div class="reader-notes" id="rnotesbox" hidden>
      <div class="reader-notes-head"><strong id="rnotestitle">My notes</strong><span class="muted" id="rvis"></span><span class="muted" id="rsaved" aria-live="polite"></span>
        <button type="button" id="rpagetag">Insert p. <span id="rpn">1</span></button></div>
      <textarea id="rnote" rows="5" maxlength="4000" aria-label="My notes" placeholder="Your notes"></textarea>
    </div></section>`);
  c.view.replaceChildren(page);
  const $ = (s) => page.querySelector(s);
  const say = (t) => { $('#rmsg').textContent = t; $('#rmsg').hidden = !t; };
  const toggle = (btn, box, on = box.hidden) => { box.hidden = !on; btn.setAttribute('aria-expanded', String(on)); return on; };
  $('#rmore').onclick = () => toggle($('#rmore'), $('#rmorebar'));

  // Paper title and its latest session (both optional: the reader still works without them). `meta` is the paper's or
  // session's own document, which a session note copies its title and date from.
  let title = src.what, meta = null;
  const metaReady = getDoc(doc(c.db, ...src.doc)).then((s) => {
    if (!s.exists()) return;
    meta = s.data();
    const t = meta.title || (meta.paperTitle ? `Slides: ${meta.paperTitle}` : '');
    title = t || title;
    $('#rtitle').textContent = t || 'PDF';
    $('#rtitle').title = t || '';
    document.title = `${t || 'PDF'} · Reader · Journal club`;
  }).catch(() => {});
  if (src.what === 'paper') getDocs(query(collection(c.db, 'sessions'), where('paperId', '==', id))).then((ss) => {
    const latest = ss.docs.map((d) => ({ id: d.id, t: d.data().date?.toMillis?.() || 0 })).sort((a, b) => b.t - a.t)[0];
    if (latest) { const a = $('#rsess'); a.href = `#/session/${latest.id}`; a.hidden = false; }
  }).catch(() => {});

  // Cached copy: read from memory. Otherwise PDF.js pulls the file from the Worker in Range chunks, so page 1 shows
  // before the rest arrives; the whole file is then fetched in the background to keep it for offline use.
  const hit = await getCached(id);
  let source;
  const hitBuf = hit ? await hit.arrayBuffer() : null;
  if (hit) source = { data: new Uint8Array(hitBuf.slice(0)) }; // PDF.js takes over (detaches) the buffer it is given
  else {
    try {
      const token = await c.user.getIdToken();
      source = { url: src.file, httpHeaders: { Authorization: `Bearer ${token}` }, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
    } catch { say('Could not open the PDF. You may be offline and it is not saved on this device.'); return; }
  }
  if (!page.isConnected) return;
  if (hit) { touch(id).catch(() => {}); }
  if (hit || isOffline(id)) $('#roff').hidden = false;

  let pdf;
  const task = getDocument(source);
  try { pdf = await task.promise; } catch (e) {
    say(e?.name === 'MissingPDFException' || e?.status === 404 ? (src.what === 'paper' ? 'This paper has no PDF.' : 'These slides have no PDF copy.') : hit ? 'This PDF could not be read.' : 'Could not open the PDF. You may be offline and it is not saved on this device.');
    return;
  }
  // The whole file, for Download and Send. Fetched early so Send can share at once (iOS needs the tap still fresh).
  let bytes = hit ? Promise.resolve(hitBuf) : null;
  if (!hit) {
    bytes = apiFetch(src.file).then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error('no file'))));
    bytes.then(async (buf) => {
      if (!page.isConnected) return;
      await keep(id, buf.slice(0));
      $('#roff').hidden = false;
      await prune(await loadStarred(c.db, c.user.uid).catch(() => new Set()));
    }).catch(() => {});
  }
  bytes.catch(() => {});
  const fileOf = async () => new File([await bytes], fileName(title), { type: 'application/pdf' });
  $('#rdl').onclick = async () => {
    try {
      const url = URL.createObjectURL(await fileOf());
      const a = Object.assign(document.createElement('a'), { href: url, download: fileName(title) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { say('Could not download the PDF. Try again when online.'); }
  };
  $('#rsend').onclick = async () => {
    let file;
    try { file = await fileOf(); } catch { say('Could not get the PDF. Try again when online.'); return; }
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title }); say(''); } catch (e) {
        if (e?.name === 'NotAllowedError') say('PDF ready: tap Send again.');
      }
      return;
    }
    // No file sharing here (most desktop browsers): share or copy the page's link instead (members only).
    const link = `${location.origin}/${src.back}`;
    try {
      if (navigator.share) await navigator.share({ title, url: link });
      else { await navigator.clipboard.writeText(link); say(`This browser cannot send files: link to the ${src.what} copied.`); }
    } catch { /* cancelled */ }
  };
  $('#rshare').hidden = false;
  const total = pdf.numPages;
  $('#pn').textContent = String(total);
  $('#pg').max = String(total);
  say('');

  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let zoom = 1, token = 0;
  const fit = () => Math.max(120, Math.min(page.clientWidth || innerWidth, innerWidth) - 16) / base.width;
  const scale = () => fit() * zoom;

  const holder = $('#pages');
  const pgs = Array.from({ length: total }, (_, i) => {
    const d = document.createElement('div');
    d.className = 'reader-pg'; d.dataset.n = String(i + 1);
    d.setAttribute('aria-label', `Page ${i + 1}`);
    holder.append(d);
    return d;
  });
  const size = (d, w, h) => { d.style.width = `${Math.round(w)}px`; d.style.height = `${Math.round(h)}px`; };
  const layout = () => pgs.forEach((d) => { if (!d.dataset.done) size(d, base.width * scale(), base.height * scale()); });

  async function paint(n) {
    const d = pgs[n - 1], mine = token, s = scale();
    if (d.dataset.done === String(s) || d.dataset.busy === String(s)) return;
    d.dataset.busy = String(s);
    try {
      const p = n === 1 ? first : await pdf.getPage(n);
      const vp = p.getViewport({ scale: s });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`; canvas.style.height = `${Math.floor(vp.height)}px`;
      await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
      if (mine !== token || !page.isConnected) return;
      d.replaceChildren(canvas);
      size(d, vp.width, vp.height);
      if (words.length) await highlight(p, vp, d);
      d.dataset.done = String(s);
    } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn('reader page', n, e?.message); }
    finally { if (d.dataset.busy === String(s)) delete d.dataset.busy; }
  }

  // The text of each page, read once; every occurrence of the search words on it, in reading order.
  const texts = new Map();
  const textOf = (p, n) => { if (!texts.has(n)) texts.set(n, p.getTextContent()); return texts.get(n); };
  const hitsIn = (content, ws) => {
    const out = [];
    for (const it of content.items) {
      const low = (it.str || '').toLowerCase();
      if (!low || !it.width) continue;
      for (const word of ws) for (let at = low.indexOf(word); at >= 0; at = low.indexOf(word, at + word.length)) out.push({ it, at, word, low });
    }
    return out;
  };

  // Marks each occurrence of the search words with a box placed over the page text.
  async function highlight(p, vp, d) {
    const hits = hitsIn(await textOf(p, Number(d.dataset.n)), words);
    for (const { it, at, word, low } of hits) {
      const tx = Util.transform(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]), w = it.width * vp.scale;
      const m = document.createElement('mark');
      m.className = 'pdf-hl';
      m.style.cssText = `left:${tx[4] + (at / low.length) * w}px;top:${tx[5] - h}px;width:${(word.length / low.length) * w}px;height:${h}px`;
      d.append(m);
    }
  }

  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const d = e.target;
      if (e.isIntersecting) paint(Number(d.dataset.n));
      else if (d.dataset.done) { d.replaceChildren(); delete d.dataset.done; layout(); } // far away: free the canvas
    }
  }, { rootMargin: '1500px 0px' });
  pgs.forEach((d) => io.observe(d));
  layout();

  const topOffset = () => ($('.reader-head').getBoundingClientRect().bottom || 0);
  const goto = (n, smooth = false) => {
    const d = pgs[Math.min(total, Math.max(1, n)) - 1];
    window.scrollTo({ top: d.getBoundingClientRect().top + scrollY - topOffset() - 4, behavior: smooth ? 'smooth' : 'auto' });
  };
  const current = () => {
    const line = topOffset() + (innerHeight - topOffset()) / 2; // the page across the middle of the reading area
    let n = 1;
    for (const d of pgs) { if (d.getBoundingClientRect().top <= line) n = Number(d.dataset.n); else break; }
    return n;
  };

  const input = $('#pg');
  // A jump (or the first landing) names the page itself; scroll events for the next moment must not rename it.
  let tick = 0, saveT = 0, last = 0, pinUntil = 0;
  const jump = (n) => { last = n; pinUntil = Date.now() + 900; input.value = String(n); goto(n); savePage(c.user.uid, id, n); };
  input.onchange = () => jump(Math.min(total, Math.max(1, Number(input.value) || 1)));
  const onScroll = () => {
    if (tick || Date.now() < pinUntil) return;
    tick = requestAnimationFrame(() => {
      tick = 0;
      if (!page.isConnected) return;
      const n = current();
      if (n === last) return;
      last = n;
      if (document.activeElement !== input) input.value = String(n);
      clearTimeout(saveT);
      saveT = setTimeout(() => savePage(c.user.uid, id, n), 300);
    });
  };
  addEventListener('scroll', onScroll, { passive: true });

  // Zoom: buttons, ctrl+wheel and a two-finger pinch. Pages are re-laid out and re-drawn at the new size.
  const redraw = () => {
    token++;
    pgs.forEach((d) => { d.replaceChildren(); delete d.dataset.done; delete d.dataset.busy; });
    layout();
    pgs.forEach((d) => { const r2 = d.getBoundingClientRect(); if (r2.bottom > -1500 && r2.top < innerHeight + 1500) paint(Number(d.dataset.n)); });
  };
  const setZoom = (z) => {
    const was = current();
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    token++;
    pgs.forEach((d) => { d.replaceChildren(); delete d.dataset.done; delete d.dataset.busy; });
    layout();
    pinUntil = Date.now() + 900;
    goto(was);
    pgs.forEach((d) => { const r2 = d.getBoundingClientRect(); if (r2.bottom > -1500 && r2.top < innerHeight + 1500) paint(Number(d.dataset.n)); });
    page.dataset.zoom = zoom.toFixed(2);
  };
  $('#zi').onclick = () => setZoom(zoom * 1.25);
  $('#zo').onclick = () => setZoom(zoom / 1.25);
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  holder.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist(e.touches), ratio: 1 }; }, { passive: true });
  holder.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    pinch.ratio = dist(e.touches) / pinch.d;
    holder.style.transform = `scale(${Math.min(2, Math.max(0.5, pinch.ratio))})`;
    holder.style.transformOrigin = '50% 0';
  }, { passive: false });
  holder.addEventListener('touchend', () => {
    if (!pinch) return;
    const ratio = pinch.ratio; pinch = null;
    holder.style.transform = '';
    if (Math.abs(ratio - 1) > 0.05) setZoom(zoom * ratio);
  });
  holder.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }, { passive: false });

  // Search in the file: the box holds the Library search term when I arrive from one; editing it re-marks the pages,
  // clearing it turns the marks off. Matches are counted page by page in the background; next/previous walk them.
  const bar = $('#rfindbar'), box = $('#rq');
  let hits = [], at = -1, scanId = 0, findT = 0;
  const count = () => { $('#rcount').textContent = !words.length ? '' : hits.length ? `${at >= 0 ? at + 1 : '–'} of ${hits.length}` : (scanId ? 'No match' : ''); };
  async function scan() {
    const mine = ++scanId; hits = []; at = -1; count();
    if (!words.length) return;
    const ws = words;
    for (let n = 1; n <= total; n++) {
      const k = hitsIn(await textOf(n === 1 ? first : await pdf.getPage(n), n), ws).length;
      if (mine !== scanId || !page.isConnected) return;
      for (let i = 0; i < k; i++) hits.push({ n, i });
      count();
    }
    if (!hits.length) $('#rcount').textContent = 'No match';
  }
  const setWords = () => {
    words = termWords(box.value);
    page.dataset.find = words.join(' ');
    redraw(); scan();
  };
  async function step(dir) {
    if (!hits.length) return;
    at = (at + dir + hits.length) % hits.length;
    const { n, i } = hits[at];
    count();
    pinUntil = Date.now() + 900;
    goto(n);
    await paint(n);
    pgs.forEach((d) => d.querySelectorAll('.pdf-hl.cur').forEach((m) => m.classList.remove('cur')));
    const m = pgs[n - 1].querySelectorAll('.pdf-hl')[i];
    if (m) { m.classList.add('cur'); m.scrollIntoView({ block: 'center' }); }
    last = n; input.value = String(n);
  }
  box.oninput = () => { clearTimeout(findT); findT = setTimeout(setWords, 300); };
  bar.onsubmit = (e) => { e.preventDefault(); clearTimeout(findT); if (termWords(box.value).join(' ') !== words.join(' ')) { setWords(); return; } step(1); };
  $('#rprev').onclick = () => step(-1);
  $('#rfind').onclick = () => { if (toggle($('#rfind'), bar)) box.focus(); };
  if (words.length) { toggle($('#rfind'), bar, true); scan(); }

  // Notes drawer: my paper note (papers/<id>/notes/<uid>, keeping the visibility it already has; a new note is Only me),
  // or my private session note (users/<uid>/sessionNotes/<sid>). Slides of a deck have no drawer.
  if (src.what === 'paper' || src.id.startsWith('sess_')) {
    const sid = src.id.replace(/^sess_/, '');
    const isPaper = src.what === 'paper';
    const ref = isPaper ? doc(c.db, 'papers', id, 'notes', c.user.uid) : doc(c.db, 'users', c.user.uid, 'sessionNotes', sid);
    const ta = $('#rnote'), saved = $('#rsaved'), tag = $('#rpagetag');
    $('#rnotestitle').textContent = isPaper ? 'My paper note' : 'My session notes';
    let shared = false, exists = false, loaded = false, pending = false, timer = 0;
    $('#rnotes').hidden = false;
    const showVis = () => { $('#rvis').textContent = isPaper ? (shared ? '· Members' : '· Only me') : '· Only me'; };
    showVis();
    const ready = Promise.all([getDoc(ref).catch(() => null), metaReady]).then(([d]) => {
      if (d?.exists()) { exists = true; shared = d.data().shared === true; ta.value = String(d.data().text || ''); showVis(); }
      loaded = true;
    });
    const save = async () => {
      clearTimeout(timer);
      if (!pending || !loaded) return;
      pending = false;
      const text = ta.value.trim();
      try {
        if (!text) {
          if (exists) { await deleteDoc(ref); exists = false; if (isPaper) await setNoted(c.db, c.user.uid, id, null); }
        } else if (isPaper) {
          await setDoc(ref, { text, rating: 0, name: c.member.name || c.user.displayName || c.user.email, shared, updatedAt: serverTimestamp() });
          exists = true; await setNoted(c.db, c.user.uid, id, Date.now());
        } else {
          await setDoc(ref, { text, paperId: meta?.paperId || '', paperTitle: String(meta?.paperTitle || '').slice(0, 400), date: meta?.date || null, updatedAt: serverTimestamp() });
          exists = true;
        }
        if (isPaper) apiFetch(`/api/index/${id}/notes`, { method: 'POST' }).catch(() => {}); // shared notes are searched server-side
        saved.textContent = text ? 'Saved ✓' : '';
      } catch (e) { console.error(e); pending = true; saved.textContent = 'Could not save. Your note is still here.'; }
    };
    ta.oninput = () => { pending = true; saved.textContent = ''; clearTimeout(timer); timer = setTimeout(save, 800); };
    ta.onblur = save;
    addEventListener('pagehide', save, { once: true });
    addEventListener('hashchange', save, { once: true });
    const curPage = () => Math.min(total, Math.max(1, Number(input.value) || 1)); // the page the header shows
    const pageTag = () => { $('#rpn').textContent = String(curPage()); };
    tag.onmousedown = (e) => e.preventDefault(); // keep the cursor in the note
    tag.onclick = () => {
      const t = `p. ${curPage()} `, a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
      ta.setRangeText(t, a, z, 'end');
      ta.dispatchEvent(new Event('input')); ta.focus();
    };
    $('#rnotes').onclick = async () => {
      const on = toggle($('#rnotes'), $('#rnotesbox'));
      page.classList.toggle('notes-open', on);
      if (on) { pageTag(); await ready; if (!ta.matches(':focus')) ta.focus(); }
    };
    input.addEventListener('change', pageTag);
    const watch = setInterval(() => { if (!page.isConnected) clearInterval(watch); else if (!$('#rnotesbox').hidden) pageTag(); }, 400);
  }

  // Open where the search hit is (else where this member stopped last time).
  const start = Math.min(total, Math.max(1, Number(r.arg2) || lastPage(c.user.uid, id) || 1));
  last = start; input.value = String(start);
  await paint(start);
  pinUntil = Date.now() + 900;
  goto(start);
  page.dataset.page = String(start);
  const firstMark = pgs[start - 1].querySelector('.pdf-hl');
  if (firstMark && Number(r.arg2)) firstMark.scrollIntoView({ block: 'center' });
  page.dataset.ready = '1';

  addEventListener('hashchange', () => { removeEventListener('scroll', onScroll); io.disconnect(); clearTimeout(saveT); task.destroy().catch(() => {}); }, { once: true });
}
