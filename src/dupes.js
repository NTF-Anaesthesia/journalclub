// Duplicate papers: the same DOI, or near-identical titles. Pure functions; the review page (src/select.js) merges.

export const normTitle = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

// Dice coefficient over letter pairs: 1 = same, ~0.9 = one or two small changes in a long title.
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i++) { const k = a.slice(i, i + 2); pairs.set(k, (pairs.get(k) || 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const k = b.slice(i, i + 2), n = pairs.get(k);
    if (n) { hit++; pairs.set(k, n - 1); }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

export const NEAR = 0.92;

// Groups of 2+ paper ids, each with why they matched. A title only matches titles of 20+ letters that start the
// same way (first 12 letters), so short generic titles ("Editorial") and different trials don't pair up.
export function findDuplicates(entries) {
  const parent = new Map(), why = new Map();
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const join = (a, b, reason) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
    why.set(a, why.get(a) || reason); why.set(b, why.get(b) || reason);
  };
  for (const [id] of entries) parent.set(id, id);
  const byDoi = new Map(), byStart = new Map(), byAtotw = new Map();
  for (const [id, p] of entries) {
    const d = String(p.doi || '').trim().toLowerCase();
    if (d) { if (byDoi.has(d)) join(byDoi.get(d), id, 'Same DOI'); else byDoi.set(d, id); }
    if (p.atotw) { if (byAtotw.has(p.atotw)) join(byAtotw.get(p.atotw), id, 'Same ATOTW number'); else byAtotw.set(p.atotw, id); }
    const t = normTitle(p.title);
    if (t.length >= 20) {
      const k = t.slice(0, 12);
      const list = byStart.get(k) || [];
      for (const [oid, ot] of list) if (similarity(t, ot) >= NEAR) join(oid, id, t === ot ? 'Same title' : 'Nearly the same title');
      list.push([id, t]); byStart.set(k, list);
    }
  }
  const groups = new Map();
  for (const [id] of entries) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((ids) => ({ ids, reason: why.get(ids[1]) || why.get(ids[0]) }));
}

// Which paper to keep: the one with the PDF, then the one with an abstract, then the older one.
export function pickKeep(a, b) {
  const score = ([, p]) => (p.file ? 4 : 0) + (p.abstract ? 2 : 0);
  if (score(a) !== score(b)) return score(a) > score(b) ? [a, b] : [b, a];
  return (a[1].addedAt?.seconds || 0) <= (b[1].addedAt?.seconds || 0) ? [a, b] : [b, a];
}
// The kept paper may only lose the other's PDF when it has its own.
export const keepAllowed = (keep, drop) => !!keep.file || !drop.file;

// What the kept paper gains: tags (up to 20), why, presented sessions, and doi/pmid/abstract it lacks.
export function mergePaper(keep, drop) {
  const tags = [...new Set([...(keep.tags || []), ...(drop.tags || [])])].slice(0, 20);
  const seen = new Set((keep.presented || []).map((e) => e.sid));
  const presented = [...(keep.presented || []), ...(drop.presented || []).filter((e) => !seen.has(e.sid))];
  const out = { edit: {}, presented: null, biblio: {} };
  if (tags.length !== (keep.tags || []).length) out.edit.tags = tags;
  if (!keep.why && drop.why) out.edit.why = drop.why;
  if (presented.length !== (keep.presented || []).length) out.presented = presented;
  for (const f of ['doi', 'pmid', 'abstract']) if (!keep[f] && drop[f]) out.biblio[f] = drop[f];
  return out;
}

// Notes on the dropped paper move to the kept one; a member with a note on both keeps both texts and the higher rating.
export function mergeNotes(keepNotes, dropNotes) {
  const mine = new Map(keepNotes.map((n) => [n.uid, n]));
  const out = [];
  for (const d of dropNotes) {
    const k = mine.get(d.uid);
    if (!k) { out.push({ ...d }); continue; }
    const text = [k.text, d.text].filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).join('\n\n').slice(0, 4000);
    const rating = Math.max(k.rating || 0, d.rating || 0);
    if (text !== (k.text || '') || rating !== (k.rating || 0)) out.push({ ...k, text, rating });
  }
  return out;
}
