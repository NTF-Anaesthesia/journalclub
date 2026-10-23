// "Tidy ATOTW" (admin, More in select mode): papers named from a file ("ATOTW 453 The Shoulder Block") get a clean title,
// the journal "Anaesthesia Tutorial of the Week", the year printed on page 1, and a number field `atotw` (not a tag).
// Fields typed by hand (`manual`) are left alone. The preview is built here; nothing is written until Apply.
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { atotwNumber } from './doi.js';
import { current, restore, dirty } from './catalogue.js';
import { sheet, snack } from './bulk.js';
import { cleanPaper } from './abstract.js';

export const ATOTW_JOURNAL = 'Anaesthesia Tutorial of the Week';
const PREFIX = /^\s*atotw[\s_#.-]*(?:no\.?\s*)?\d{1,4}(?!\d)[\s_.:–—-]*/i;
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
const squash = (s) => String(s || '').replace(/[_\s]+/g, ' ').trim();

// Sentence case: first letter capital, the rest lower case, except acronyms. In a title written in capitals a word is
// kept as an acronym when it is on the list, holds a digit, or is two letters and not an ordinary short word (IV, CT, GI);
// in a mixed-case title any word with two or more capitals stays ("ICU", "pH"). Proper names are lowered: fix by hand.
const ACRONYMS = new Set('ICU ECG EEG EMG CPR ECMO ARDS COPD MRI TIVA TAP CPAP PEEP NIV ICP ASA GCS ENT OSA PONV AKI CKD DVT HIV AIDS MAC SIRS ICD NICE BMI TOF TEG ROTEM ERAS CVC ETT LMA RSI NMDA GABA UK USA WHO'.split(' '));
const SHORT = new Set('THE AND FOR OF IN ON TO BY AN A OR AT IS AS BE NOT NO ITS ARE WAS ALL OUT OFF PRE POST VS WITH FROM'.split(' '));
export function sentenceCase(title) {
  const t = String(title || '');
  const caps = t === t.toUpperCase();
  let first = true;
  return t.replace(/[A-Za-z\u00c0-\u00ff0-9']+/g, (w) => {
    const upper = w === w.toUpperCase() && /[A-Z]/.test(w);
    const keep = caps
      ? ACRONYMS.has(w) || /\d/.test(w) || (w.length === 2 && !SHORT.has(w))
      : (w.match(/[A-Z\u00c0-\u00de]/g) || []).length >= 2 || /^[a-z]+[A-Z]/.test(w) || (upper && w.length > 1) || /\d/.test(w);
    const out = keep ? w : w.toLowerCase();
    const r = first ? out[0].toUpperCase() + out.slice(1) : out;
    first = false;
    return r;
  });
}

// The title without its "ATOTW <n>" start, underscores as spaces; '' when nothing is left.
export const strippedTitle = (title) => squash(String(title || '').replace(PREFIX, ''));

// The same words as `plain`, in the page's own spelling and capitals, when page 1 prints them in a row; else null.
export function pageSpan(plain, page) {
  const w = words(plain);
  if (w.length < 2) return null;
  const re = new RegExp(w.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]+'), 'i');
  return re.exec(String(page || '').replace(/\s+/g, ' '))?.[0].trim() || null;
}

// The year printed on a tutorial's first page ("20 May 2025", "May 2025"); only when the page names the series.
export function pageYear(page) {
  const t = String(page || '').replace(/\s+/g, ' ');
  if (!/tutorial\s+of\s+the\s+week/i.test(t)) return null;
  return Number(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]
    || new RegExp(`\\b${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]) || null;
}

// What Tidy would write for one stored paper given its page-1 text ('' when none), or null when it is not an ATOTW paper.
// status: 'change' | 'same' | 'unsure' (nothing usable left of the title).
export function tidyPlan(p, page1 = '') {
  const n = p.atotw || (/^\s*atotw\b/i.test(p.title || '') ? atotwNumber(p.title) : null);
  if (!n || n > 2000) return null;
  const manual = new Set(p.manual || []);
  const plain = strippedTitle(p.title);
  const oldTitle = p.title || '';
  const next = {};
  if (!manual.has('title')) {
    let title = pageSpan(plain, page1) || plain;
    title = sentenceCase(title);
    if (title && title !== oldTitle) next.title = title.slice(0, 500);
    else if (!title && !p.atotw) return { n, next: {}, status: 'unsure', note: 'No title left after the number' };
  }
  if (!manual.has('journal') && p.journal !== ATOTW_JOURNAL) next.journal = ATOTW_JOURNAL;
  const year = pageYear(page1);
  if (!manual.has('year') && year && year !== p.year) next.year = year;
  if (p.atotw !== n) next.atotw = n;
  return { n, next, status: Object.keys(next).length ? 'change' : 'same' };
}

// What to store: the changes, the fields of title/journal/year that changed added to `manual`.
export function tidyWrite(p, plan) {
  const out = { ...plan.next };
  const hand = new Set(p.manual || []);
  for (const k of ['title', 'journal', 'year']) if (k in plan.next) hand.add(k);
  if (hand.size !== (p.manual || []).length) out.manual = [...hand];
  return out;
}

const api = (c, path) => c.user.getIdToken().then((t) => fetch(path, { headers: { Authorization: `Bearer ${t}` } }));
const esc = (c, s) => c.esc(String(s ?? ''));

// Admin: preview, then Apply. Two papers with the same number are listed as unsure (merge them first under Find duplicates).
export async function tidyAtotw(c, ids, onChange) {
  const lib = current();
  const picked = ids.map((id) => [id, lib.papers.get(id)]).filter(([, p]) => p && (p.atotw || /^\s*atotw\b/i.test(p.title || '')));
  const d = sheet(c, 'Tidy ATOTW', `<h2 class="sheet-title">Tidy ATOTW</h2><p class="muted" id="tmsg" role="status">Reading page 1 of ${picked.length} papers…</p><ul class="list" id="tlist"></ul>
    <div class="sheet-buttons"><button type="button" id="tcancel">Cancel</button><button type="button" class="primary" id="tapply" disabled>Apply</button></div>`);
  const $ = (s) => d.querySelector(s);
  $('#tcancel').onclick = () => d.close();
  const plans = new Map();
  let next = 0;
  const worker = async () => {
    while (next < picked.length && d.isConnected) {
      const [id, p] = picked[next++];
      let page = '';
      try {
        const r = p.file ? await api(c, `/api/firstpage/${id}`) : null;
        if (r?.ok) page = (await r.json()).pages?.[0] || '';
      } catch { /* offline: the title is tidied without page 1 */ }
      const plan = tidyPlan(p, page);
      if (plan) plans.set(id, plan);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (!d.isConnected) return;
  const count = new Map();
  for (const [, plan] of plans) count.set(plan.n, (count.get(plan.n) || 0) + 1);
  for (const [, plan] of plans) if (count.get(plan.n) > 1) Object.assign(plan, { status: 'unsure', next: {}, note: 'Same number as another paper: merge them first' });
  const rows = [...plans].filter(([, pl]) => pl.status !== 'same');
  const tally = { change: 0, same: 0, unsure: 0 };
  for (const [, pl] of plans) tally[pl.status]++;
  $('#tmsg').textContent = `${tally.change} to change, ${tally.same} already tidy, ${tally.unsure} unsure. Nothing is saved until you tap Apply.`;
  $('#tlist').replaceChildren(...rows.map(([id, pl]) => {
    const p = lib.papers.get(id), n = pl.next;
    const bits = [n.title !== undefined && `Title: ${esc(c, p.title)} → ${esc(c, n.title)}`, n.journal && `Journal: ${esc(c, n.journal)}`,
      n.year && `Year: ${esc(c, n.year)}`, `No. ${pl.n}`].filter(Boolean);
    return c.el(`<li class="tidy-row"><span class="${pl.status === 'unsure' ? 'warn-text' : ''}">${pl.note ? esc(c, pl.note) + ' · ' : ''}${bits.join('<br>')}</span></li>`);
  }));
  const apply = $('#tapply');
  apply.disabled = !tally.change;
  apply.textContent = tally.change ? `Apply to ${tally.change}` : 'Nothing to apply';
  apply.onclick = async () => {
    apply.disabled = true;
    let done = 0, failed = 0;
    for (const [id, pl] of plans) {
      if (pl.status !== 'change') continue;
      try {
        const snap = await getDoc(doc(c.db, 'papers', id));
        if (!snap.exists()) { failed++; continue; }
        const p = snap.data();
        const kept = Object.fromEntries(Object.entries(pl.next).filter(([k]) => !(p.manual || []).includes(k))); // typed since the preview
        const ch = tidyWrite(p, { ...pl, next: kept });
        await updateDoc(snap.ref, { ...ch, changedAt: serverTimestamp() });
        restore(id, cleanPaper({ ...p, ...ch }));
        done++;
      } catch (err) { console.error(err); failed++; }
      $('#tmsg').textContent = `Applied ${done} of ${tally.change}…`;
    }
    dirty();
    d.close();
    onChange?.();
    snack(c, `Tidied ${done}${failed ? `, ${failed} failed` : ''}; ${tally.same} unchanged, ${tally.unsure} unsure`);
  };
}
