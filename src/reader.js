// In-app PDF reader: #/read/<paper>/<page>?q=<term>. Continuous scroll, pinch or +/- zoom, page jump, the search term
// highlighted, last page remembered per member on this device. The PDF comes from the offline cache when it is there,
// else from the Worker in Range chunks (and is then kept for offline use). Streaming is off on purpose: the plain
// network loader always opens with a small Range request, so only the chunks the first page needs are downloaded.
import './polyfills.js';
import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist';
import { doc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { getCached, keep, touch, prune, isOffline } from './offline.js';
import { loadStarred } from './prefs.js';

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

// Words of the search term worth highlighting (lower case, 2+ letters).
export const termWords = (q) => [...new Set(String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 6);

export async function renderReader(r, c, apiFetch) {
  const id = r.arg;
  const words = termWords(r.q);
  const page = c.el(`<section class="card reader">
    <div class="reader-bar">
      <a href="#/paper/${c.esc(id)}" id="rback">← Back to paper</a>
      <a href="#/paper/${c.esc(id)}" id="rsess" hidden>Session</a>
      <span class="badge" id="roff" hidden>Offline copy</span>
    </div>
    <h1 class="reader-title" id="rtitle">PDF</h1>
    <div class="reader-tools">
      <label class="reader-jump">Page <input id="pg" type="number" inputmode="numeric" min="1" value="1" aria-label="Page number"> <span class="muted">of <span id="pn">…</span></span></label>
      <button type="button" id="zo" aria-label="Zoom out">−</button><button type="button" id="zi" aria-label="Zoom in">+</button>
    </div>
    <p id="rmsg" class="muted">Opening…</p><div id="pages" class="reader-pages"></div></section>`);
  c.view.replaceChildren(page);
  const $ = (s) => page.querySelector(s);
  const say = (t) => { $('#rmsg').textContent = t; $('#rmsg').hidden = !t; };

  // Paper title and its latest session (both optional: the reader still works without them).
  getDoc(doc(c.db, 'papers', id)).then((s) => {
    if (!s.exists()) return;
    $('#rtitle').textContent = s.data().title || 'PDF';
    document.title = `${s.data().title || 'PDF'} · Reader · Journal club`;
  }).catch(() => {});
  getDocs(query(collection(c.db, 'sessions'), where('paperId', '==', id))).then((ss) => {
    const latest = ss.docs.map((d) => ({ id: d.id, t: d.data().date?.toMillis?.() || 0 })).sort((a, b) => b.t - a.t)[0];
    if (latest) { const a = $('#rsess'); a.href = `#/session/${latest.id}`; a.hidden = false; }
  }).catch(() => {});

  // Cached copy: read from memory. Otherwise PDF.js pulls the file from the Worker in Range chunks, so page 1 shows
  // before the rest arrives; the whole file is then fetched in the background to keep it for offline use.
  const hit = await getCached(id);
  let source;
  if (hit) source = { data: new Uint8Array(await hit.arrayBuffer()) };
  else {
    try {
      const token = await c.user.getIdToken();
      source = { url: `/api/file/${id}`, httpHeaders: { Authorization: `Bearer ${token}` }, rangeChunkSize: RANGE_CHUNK, disableAutoFetch: true, disableStream: true };
    } catch { say('Could not open the PDF. You may be offline and it is not saved on this device.'); return; }
  }
  if (!page.isConnected) return;
  if (hit) { touch(id).catch(() => {}); }
  if (hit || isOffline(id)) $('#roff').hidden = false;

  let pdf;
  const task = getDocument(source);
  try { pdf = await task.promise; } catch (e) {
    say(e?.name === 'MissingPDFException' || e?.status === 404 ? 'This paper has no PDF.' : hit ? 'This PDF could not be read.' : 'Could not open the PDF. You may be offline and it is not saved on this device.');
    return;
  }
  if (!hit) {
    apiFetch(`/api/file/${id}`).then(async (res) => {
      if (!res.ok || !page.isConnected) return;
      await keep(id, await res.arrayBuffer());
      $('#roff').hidden = false;
      await prune(await loadStarred(c.db, c.user.uid).catch(() => new Set()));
    }).catch(() => {});
  }
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

  // Marks each occurrence of the search words with a box placed over the page text.
  async function highlight(p, vp, d) {
    const content = await p.getTextContent();
    for (const it of content.items) {
      const low = (it.str || '').toLowerCase();
      if (!low || !it.width) continue;
      const tx = Util.transform(vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]), w = it.width * vp.scale;
      for (const word of words) {
        for (let at = low.indexOf(word); at >= 0; at = low.indexOf(word, at + word.length)) {
          const m = document.createElement('mark');
          m.className = 'pdf-hl';
          m.style.cssText = `left:${tx[4] + (at / low.length) * w}px;top:${tx[5] - h}px;width:${(word.length / low.length) * w}px;height:${h}px`;
          d.append(m);
        }
      }
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

  const topOffset = () => ($('.reader-tools').getBoundingClientRect().bottom || 0);
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
