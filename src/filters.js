// Library list: filter chips, sort orders and counts over the cached catalogue (no Firestore reads).
// `x` carries what is not on the paper itself: { starred: Set, indexed: Set | null, ratings: Map, recent: [ids] }.

export const SORTS = [
  ['newest', 'Newest first'], ['year', 'Year'], ['title', 'Title'], ['author', 'First author'],
  ['rating', 'Average rating'], ['recent', 'Recently opened'],
];
export const sortLabel = (k) => (SORTS.find(([s]) => s === k) || SORTS[0])[1];

// [key, label, test(paper, id, x)]. "PDF not indexed" only counts once the Worker has said which PDFs are indexed.
export const CHIPS = [
  ['noAbstract', 'No abstract', (p) => !p.abstract],
  ['noDoi', 'No DOI', (p) => !p.doi],
  ['noPdf', 'No PDF', (p) => !p.file],
  ['notIndexed', 'PDF not indexed', (p, id, x) => !!p.file && !!x.indexed && !x.indexed.has(id)],
  ['untagged', 'Untagged', (p) => !(p.tags || []).length],
  ['starred', 'Starred', (p, id, x) => x.starred.has(id)],
  ['presented', 'Presented', (p) => (p.presented || []).length > 0],
];
const TEST = Object.fromEntries(CHIPS.map(([k, , t]) => [k, t]));

// state: { chips: Set of chip keys, tag: string | null, yearFrom: number | null, yearTo: number | null }
export const emptyFilter = () => ({ chips: new Set(), tag: null, yearFrom: null, yearTo: null });
export const filterOn = (f) => f.chips.size > 0 || !!f.tag || f.yearFrom != null || f.yearTo != null;

export function matches(id, p, f, x) {
  for (const k of f.chips) if (TEST[k] && !TEST[k](p, id, x)) return false;
  if (f.tag && !(p.tags || []).includes(f.tag)) return false;
  if (f.yearFrom != null && !(p.year >= f.yearFrom)) return false;
  if (f.yearTo != null && !(p.year <= f.yearTo)) return false;
  return true;
}

// Counts per chip over the whole catalogue (not narrowed by the other chips), as the chip row shows them.
export function chipCounts(entries, x) {
  const out = Object.fromEntries(CHIPS.map(([k]) => [k, 0]));
  for (const [id, p] of entries) for (const [k, , t] of CHIPS) if (t(p, id, x)) out[k]++;
  return out;
}

// Tags with their paper counts, most used first.
export function tagCounts(entries) {
  const n = new Map();
  for (const [, p] of entries) for (const t of p.tags || []) n.set(t, (n.get(t) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const added = (p) => p.addedAt?.seconds || 0;
const byNewest = (a, b) => added(b[1]) - added(a[1]);
const text = (s) => String(s || '').replace(/^(the|a|an)\s+/i, '').trim();
const surname = (p) => String((p.authors || [])[0] || '').trim().split(/\s+/).pop() || '';
// Missing values sort last whatever the order.
const last = (a, b, cmp) => (a === '' || a == null ? (b === '' || b == null ? 0 : 1) : b === '' || b == null ? -1 : cmp());

export function sortEntries(entries, sort, x = {}) {
  const e = [...entries];
  if (sort === 'year') return e.sort((a, b) => last(a[1].year, b[1].year, () => b[1].year - a[1].year) || byNewest(a, b));
  if (sort === 'title') return e.sort((a, b) => text(a[1].title).localeCompare(text(b[1].title), 'en', { sensitivity: 'base' }));
  if (sort === 'author') {
    return e.sort((a, b) => last(surname(a[1]), surname(b[1]), () => surname(a[1]).localeCompare(surname(b[1]), 'en', { sensitivity: 'base' })) || byNewest(a, b));
  }
  if (sort === 'rating') {
    const r = x.ratings || new Map();
    return e.sort((a, b) => last(r.get(a[0]), r.get(b[0]), () => r.get(b[0]) - r.get(a[0])) || byNewest(a, b));
  }
  if (sort === 'recent') {
    const at = new Map((x.recent || []).map((id, i) => [id, i]));
    return e.sort((a, b) => last(at.get(a[0]), at.get(b[0]), () => at.get(a[0]) - at.get(b[0])) || byNewest(a, b));
  }
  return e.sort(byNewest);
}

// Average rating per paper from note docs ({ paperId, rating }); unrated notes don't count.
export function averageRatings(notes) {
  const sum = new Map();
  for (const { paperId, rating } of notes) {
    if (!(rating > 0)) continue;
    const s = sum.get(paperId) || [0, 0];
    sum.set(paperId, [s[0] + rating, s[1] + 1]);
  }
  return new Map([...sum].map(([id, [t, n]]) => [id, t / n]));
}

// "Select all": with no filter or search, the rows already on screen; otherwise every match, capped.
export const SELECT_CAP = 200;
export function selectAll(visibleIds, matchIds, narrowed) {
  return narrowed ? matchIds.slice(0, SELECT_CAP) : visibleIds;
}

// Tri-state for the Add to… sheet: how many of the selected papers are in a list or carry a tag.
export function triState(selected, has) {
  let n = 0;
  for (const id of selected) if (has(id)) n++;
  return n === 0 ? 'none' : n === selected.length ? 'all' : 'some';
}
