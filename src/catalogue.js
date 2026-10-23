// The library catalogue (paper metadata only), shared by the library pages and the club's Plan a session sheet.
// It lives in Firestore's persistent cache. A repeat open reads the cache, then only the papers whose changedAt
// is newer than the newest one seen, plus one count; a count that doesn't match (a paper removed elsewhere)
// falls back to a full read. Stats for tests: window.__jcCatalogue; timings: window.__jcTiming.
import { getDocs, getDocsFromCache, getCountFromServer, collection, query, where, Timestamp } from 'firebase/firestore';
import { buildIndex, updateIndex } from './search.js';
import { cleanPaper } from './abstract.js';

const SYNC_KEY = 'jc.catalogueSync';
const HEAD_KEY = 'jc.head';
let lib = null; // { papers, built, stale, index }

export const timing = typeof window !== 'undefined' ? (window.__jcTiming = window.__jcTiming || {}) : {};

export const readSync = () => { try { const v = JSON.parse(localStorage.getItem(SYNC_KEY)); return v && new Timestamp(v.s, v.n); } catch { return null; } };
const writeSync = (t) => { try { localStorage.setItem(SYNC_KEY, JSON.stringify({ s: t.seconds, n: t.nanoseconds })); } catch { /* private mode */ } };
const newest = (papers, since) => {
  let t = since;
  for (const p of papers.values()) if (p.changedAt?.toMillis && (!t || p.changedAt > t)) t = p.changedAt;
  return t;
};

export const current = () => lib;

// A Firestore call that hangs (seen on a phone: the count never came back) must not hold the page.
export const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} timed out`), { code: 'timeout' })), ms))]);
// How long a read took, in window.__jcTiming, so a stall shows which read it was.
export const timed = (key, p) => { const t = performance.now(); const done = () => { timing[key] = Math.round(performance.now() - t); }; p.then(done, done); return p; };
// One line a member can paste when the library hangs: browser, connection and the read timings.
export const diagnostics = () => {
  const n = typeof navigator !== 'undefined' ? navigator : {}, c = n.connection || {};
  return JSON.stringify({ t: new Date().toISOString(), ua: n.userAgent, online: n.onLine, net: { type: c.effectiveType, rtt: c.rtt, down: c.downlink, save: c.saveData },
    sync: !!readSync(), head: readHead()?.length || 0, ...timing });
};
const note = (k, e) => { timing[k] = e?.code || e?.message || String(e); console.warn('catalogue', k, e); };

export async function loadLibrary(db) {
  if (lib && !lib.stale) return lib;
  const t0 = performance.now();
  const col = collection(db, 'papers');
  let since = readSync();
  let papers = lib?.papers || null, fetched = 0, mode = 'delta';
  if (!papers && since) {
    try {
      const cached = await getDocsFromCache(col);
      if (!cached.empty) papers = new Map(cached.docs.map((d) => [d.id, cleanPaper(d.data())]));
    } catch { /* no cache */ }
    timing.cache = Math.round(performance.now() - t0);
  }
  if (papers && since) {
    // The count only catches papers removed elsewhere: if it fails or is slow, keep the cached list and say so.
    const [delta, count] = await Promise.all([timed('deltaMs', getDocs(query(col, where('changedAt', '>', since)))),
      withTimeout(timed('countMs', getCountFromServer(col)), 4000, 'count').catch((e) => { note('countError', e); return null; })]);
    delta.docs.forEach((d) => { papers.set(d.id, cleanPaper(d.data())); if (lib?.built) updateIndex(lib.built, d.id, papers.get(d.id)); });
    fetched = delta.size;
    if (count && papers.size !== count.data().count) papers = null;
    else if (!count) mode = 'delta-nocount';
  }
  if (!papers || !since) {
    const all = await getDocs(col);
    papers = new Map(all.docs.map((d) => [d.id, cleanPaper(d.data())]));
    fetched = all.size; mode = 'full'; since = null;
  }
  const t = newest(papers, since);
  if (t) writeSync(t);
  const keep = mode !== 'full' && lib?.built;
  lib = { papers, built: keep ? lib.built : null, stale: false,
    get index() { // built when idle after the first paint, or on the first keystroke
      if (!this.built) { const s = performance.now(); this.built = buildIndex(this.papers); timing.index = Math.round(performance.now() - s); }
      return this.built;
    } };
  timing.load = Math.round(performance.now() - t0);
  if (typeof window !== 'undefined') window.__jcCatalogue = { mode, fetched, size: papers.size };
  return lib;
}
export const dirty = () => { if (lib) lib.stale = true; };
// A paper removed here, or found missing: drop it now rather than re-reading the catalogue.
export const forget = (id) => { if (lib) { lib.papers.delete(id); if (lib.built) updateIndex(lib.built, id, null); } };
export const restore = (id, p) => { if (lib) { lib.papers.set(id, p); if (lib.built) updateIndex(lib.built, id, p); } };

// The newest 50 rows, saved on this device so the next open paints them before the catalogue loads.
const slim = ([id, p]) => [id, {
  title: p.title, journal: p.journal, year: p.year, tags: p.tags || [], authors: (p.authors || []).slice(0, 4),
  file: p.file ? { pages: p.file.pages } : null, abstract: p.abstract ? '1' : '', doi: p.doi || '',
  presented: (p.presented || []).slice(-2).map((e) => ({ sid: e.sid, date: e.date?.toMillis ? e.date.toMillis() : e.date })),
}];
export function writeHead(entries) {
  try { localStorage.setItem(HEAD_KEY, JSON.stringify(entries.slice(0, 50).map(slim))); } catch { /* full or private */ }
}
// Stand-in catalogue from the saved head when the real one is slow: marked partial so the count says "50+".
export function headCatalogue() {
  const papers = new Map(readHead() || []);
  return { papers, partial: true, built: null, get index() { if (!this.built) this.built = buildIndex(this.papers); return this.built; } };
}
export function readHead() {
  try { const v = JSON.parse(localStorage.getItem(HEAD_KEY)); return Array.isArray(v) ? v : null; } catch { return null; }
}
