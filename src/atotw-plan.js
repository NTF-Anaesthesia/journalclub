// The rules of "Tidy ATOTW", without the page: shared by the app (src/atotw.js) and scripts/tidy-atotw.mjs, so a run
// from a script does exactly what the preview shows. Papers named from a file ("ATOTW 453 The Shoulder Block") get a clean title,
// the journal "Anaesthesia Tutorial of the Week", the year printed on page 1, and a number field `atotw` (not a tag).
// Fields typed by hand (`manual`) are left alone. The preview is built here; nothing is written until Apply.
import { atotwNumber } from './doi.js';

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
// `loose` (the paper is known to be an ATOTW): else the first plain year 2000-2030 in the first 600 characters.
export function pageYear(page, loose = false) {
  const t = String(page || '').replace(/\s+/g, ' ');
  if (/tutorial\s+of\s+the\s+week/i.test(t)) {
    const y = Number(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]
      || new RegExp(`\\b${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]) || null;
    if (y) return y;
  }
  const y = loose && /\b(20[0-2]\d|2030)\b/.exec(t.slice(0, 600))?.[1];
  return y ? Number(y) : null;
}

// The year in a Worker lookup ({ year }) or a Crossref work record (https://api.crossref.org/works/10.28923/atotw.<n>), or null.
export function crossrefYear(rec) {
  const m = rec?.message || rec;
  const y = Number.isInteger(m?.year) ? m.year
    : (m?.issued || m?.published || m?.['published-online'] || m?.['published-print'])?.['date-parts']?.[0]?.[0];
  return Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null;
}

// What Tidy would write for one stored paper given its page-1 text ('' when none) and a looked-up year (or null), or null when it is not an ATOTW paper.
// status: 'change' | 'same' | 'unsure' (nothing usable left of the title).
export function tidyPlan(p, page1 = '', lookupYear = null) {
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
  const year = pageYear(page1, true) || lookupYear;
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

