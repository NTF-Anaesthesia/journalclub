// Library search syntax, Evernote style. Free words are ANDed (prefix match, typo-tolerant on metadata);
// "exact phrase", a OR b, -word excludes. Operators narrow by field, and may be negated (-tag:x):
//   tag:airway  #airway  author:lee  journal:anaesthesia  year:2020  year:2018-2024  year:>2020
//   is:starred  is:presented  is:mine  has:pdf  has:abstract  has:doi  has:slides  has:tags
//   in:title  in:abstract  in:pdf  in:notes   (where the free words must match)
import { decodeEntities } from './abstract.js';

const FIELD = {
  tag: 'tag', tags: 'tag', author: 'author', au: 'author', by: 'author', journal: 'journal', j: 'journal',
  year: 'year', y: 'year', is: 'is', has: 'has', in: 'in',
};
export const IS = ['starred', 'presented', 'mine'];
export const HAS = ['pdf', 'abstract', 'doi', 'slides', 'tags'];
export const IN = ['title', 'abstract', 'pdf', 'notes'];

// Lower case, accents off: "Müller" matches "muller".
export const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s) => fold(s).match(/[\p{L}\p{N}]+/gu) || [];

// Splits the box into tokens: [{ neg, field, value, phrase }] and 'OR' markers. Unclosed quotes run to the end.
function tokens(q) {
  const out = [];
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))|(#)(\S+)/gi;
  for (const m of String(q || '').matchAll(re)) {
    if (m[5]) { out.push({ neg: false, field: 'tag', value: m[6], phrase: false }); continue; }
    const field = m[2] && FIELD[m[2].toLowerCase()];
    const phrase = m[3] != null;
    let value = phrase ? m[3] : m[4];
    if (m[2] && !field) value = `${m[2]}:${value ?? ''}`; // not an operator: plain text
    if (!field && !phrase && !m[1] && value === 'OR') { out.push('OR'); continue; }
    if (value == null || !value.trim()) continue;
    if (value.startsWith('#') && !field && !phrase) { out.push({ neg: !!m[1], field: 'tag', value: value.slice(1), phrase: false }); continue; }
    out.push({ neg: !!m[1], field: field || null, value: value.trim(), phrase });
  }
  return out;
}

// { groups: [[term]] (AND of ORs), not: [term], filters: [{ field, value, neg }], scope, text, words, empty }
// term: { text, phrase }. `text` is true when there are free words to search for.
export function parseQuery(q) {
  const groups = [], not = [], filters = [];
  let scope = null, joinNext = false;
  for (const t of tokens(q)) {
    if (t === 'OR') { joinNext = groups.length > 0; continue; }
    if (t.field === 'in') { if (IN.includes(fold(t.value))) scope = fold(t.value); joinNext = false; continue; }
    if (t.field) { filters.push({ field: t.field, value: fold(t.value), neg: t.neg, raw: t.value }); joinNext = false; continue; }
    const term = { text: t.value, phrase: t.phrase };
    if (!words(term.text).length) { joinNext = false; continue; }
    if (t.neg) { not.push(term); joinNext = false; continue; }
    if (joinNext) groups.at(-1).push(term); else groups.push([term]);
    joinNext = false;
  }
  const all = [...new Set(groups.flat().flatMap((t) => words(t.text)))];
  return { groups, not, filters, scope, text: groups.length > 0, words: all, empty: !groups.length && !not.length && !filters.length && !scope };
}

// Years: 2020, 2018-2024, 2018..2024, 2018-, -2015, >2020, >=2020, <2015, <=2015. Null when unreadable.
export function yearRange(v) {
  const s = String(v).replace(/\s/g, '');
  let m;
  if ((m = /^(\d{4})$/.exec(s))) return [+m[1], +m[1]];
  if ((m = /^(\d{4})?(?:-|\.\.)(\d{4})?$/.exec(s)) && (m[1] || m[2])) return [m[1] ? +m[1] : -Infinity, m[2] ? +m[2] : Infinity];
  if ((m = /^(>=?|<=?)(\d{4})$/.exec(s))) {
    const y = +m[2];
    return m[1] === '>' ? [y + 1, Infinity] : m[1] === '>=' ? [y, Infinity] : m[1] === '<' ? [-Infinity, y - 1] : [-Infinity, y];
  }
  return null;
}

// The paper's own words, folded, for exact phrases and excluded words (metadata only).
export const haystack = (p) => fold([p.title, (p.authors || []).join(' '), p.journal, (p.tags || []).join(' '), p.why,
  decodeEntities(p.abstract)].filter(Boolean).join(' ')).replace(/[^\p{L}\p{N}]+/gu, ' ');
const hasWords = (hay, text) => {
  const w = words(text);
  return w.length > 0 && ` ${hay}`.includes(` ${w.join(' ')}`); // phrase: the words in a row, last one as a prefix
};

// One operator against a paper. `x`: { starred: Set, uid, slides: Set of paper ids }.
function test1(f, id, p, x) {
  const v = f.value;
  switch (f.field) {
    case 'tag': return (p.tags || []).some((t) => fold(t) === v || (v.endsWith('*') && fold(t).startsWith(v.slice(0, -1))));
    case 'author': return (p.authors || []).some((a) => words(a).some((w) => w.startsWith(v)) || fold(a).includes(v));
    case 'journal': return fold(p.journal).includes(v);
    case 'year': { const r = yearRange(v); return !!r && p.year >= r[0] && p.year <= r[1]; }
    case 'is':
      if (v === 'starred') return !!x.starred?.has(id);
      if (v === 'presented') return (p.presented || []).length > 0;
      if (v === 'mine') return !!x.uid && p.addedBy === x.uid;
      return true;
    case 'has':
      if (v === 'pdf') return !!p.file;
      if (v === 'abstract') return !!p.abstract;
      if (v === 'doi') return !!p.doi;
      if (v === 'slides') return !!x.slides?.has(id);
      if (v === 'tags' || v === 'tag') return (p.tags || []).length > 0;
      return true;
    default: return true;
  }
}

// Operators and excluded words; free words are left to the search itself.
export function queryMatches(id, p, parsed, x = {}) {
  for (const f of parsed.filters) if (test1(f, id, p, x) === f.neg) return false;
  if (parsed.not.length) {
    const hay = haystack(p);
    for (const t of parsed.not) if (hasWords(hay, t.text)) return false;
  }
  return true;
}

// A metadata hit keeps its exact phrases (a PDF or notes hit is checked by the server instead).
export const phrasesMatch = (p, parsed) => {
  const ph = parsed.groups.filter((g) => g.length === 1 && g[0].phrase);
  if (!ph.length) return true;
  const hay = haystack(p);
  return ph.every((g) => hasWords(hay, g[0].text));
};

// MiniSearch query for the free words; null when there are none.
export function miniQuery(parsed) {
  if (!parsed.text) return null;
  const one = (t) => (t.phrase ? { queries: [words(t.text).join(' ')], combineWith: 'AND', prefix: (w, i, all) => i === all.length - 1, fuzzy: false } : t.text);
  return { combineWith: 'AND', queries: parsed.groups.map((g) => (g.length === 1 ? one(g[0]) : { combineWith: 'OR', queries: g.map(one) })) };
}
export const MINI_FIELDS = { title: ['title'], abstract: ['abstract'] };

// What the Worker searches (PDF text and notes): words, "phrases", OR and -words, in the same syntax.
export function serverQuery(parsed) {
  if (!parsed.text || parsed.scope === 'title' || parsed.scope === 'abstract') return '';
  const t = (x) => (x.phrase ? `"${words(x.text).join(' ')}"` : words(x.text).join(' '));
  const pos = parsed.groups.map((g) => g.map(t).join(' OR ')).join(' ');
  const neg = parsed.not.map((x) => `-${x.phrase ? `"${words(x.text).join(' ')}"` : words(x.text)[0]}`).join(' ');
  return `${pos}${neg ? ` ${neg}` : ''}`;
}

// The token being typed (the last one, unless the box ends in a space): { start, field, partial, neg }.
export function lastToken(q) {
  const s = String(q || '');
  if (!s || /\s$/.test(s)) return { start: s.length, field: null, partial: '', neg: false };
  const m = /(-?)(?:([a-z]+):)?("?)([^\s"]*)$/i.exec(s);
  const field = m[2] && FIELD[m[2].toLowerCase()];
  return { start: m.index, field: field || null, partial: m[2] && !field ? `${m[2]}:${m[4]}` : m[4], neg: !!m[1] };
}

const quote = (v) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);
export const op = (field, value, neg = false) => `${neg ? '-' : ''}${field}:${quote(value)}`;

// Suggestions for the token being typed: [{ label, hint, insert }] (insert replaces that token).
// `facets`: { tags: [[tag, n]], authors: [[name, n]], journals: [[name, n]] }, most used first.
export function suggest(q, facets, max = 8) {
  const t = lastToken(q);
  const p = fold(t.partial);
  const out = [];
  const add = (field, list, label = field) => {
    for (const [v, n] of list) {
      if (out.length >= max) return;
      if (!p || fold(v).split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(p)) || fold(v).startsWith(p)) out.push({ label: op(label, v, t.neg), hint: `${n}`, insert: `${op(label, v, t.neg)} ` });
    }
  };
  const fixed = (field, vals) => vals.filter((v) => v.startsWith(p)).forEach((v) => out.push({ label: op(field, v, t.neg), hint: '', insert: `${op(field, v, t.neg)} ` }));
  if (t.field === 'tag') add('tag', facets.tags);
  else if (t.field === 'author') add('author', facets.authors);
  else if (t.field === 'journal') add('journal', facets.journals);
  else if (t.field === 'is') fixed('is', IS);
  else if (t.field === 'has') fixed('has', HAS);
  else if (t.field === 'in') fixed('in', IN);
  else if (t.field === 'year') {
    const y = new Date().getFullYear();
    [`${y}`, `${y - 5}-${y}`, `>${y - 2}`].filter((v) => v.startsWith(t.partial)).forEach((v) => out.push({ label: `year:${v}`, hint: '', insert: `year:${v} ` }));
  } else if (p.length >= 2) {
    add('tag', facets.tags.slice(0, 400));
    add('author', facets.authors.slice(0, 2000));
    add('journal', facets.journals.slice(0, 400));
    for (const f of Object.keys(FIELD)) if (f.length > 2 && f.startsWith(p) && out.length < max) out.push({ label: `${f}:`, hint: 'operator', insert: `${t.neg ? '-' : ''}${f}:` });
  }
  return out.slice(0, max);
}

// Tags, authors (as written on the papers) and journals with their paper counts, most used first.
export function facets(entries) {
  const count = (pick) => {
    const n = new Map(), name = new Map();
    for (const [, p] of entries) for (const v of new Set(pick(p).filter(Boolean))) {
      const k = fold(v);
      n.set(k, (n.get(k) || 0) + 1);
      if (!name.has(k)) name.set(k, String(v).trim());
    }
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, c]) => [name.get(k), c]);
  };
  return {
    tags: count((p) => p.tags || []),
    authors: count((p) => (p.authors || []).map((a) => String(a).trim().split(/\s+/).pop())),
    journals: count((p) => [p.journal]),
  };
}

// The search words marked in a piece of text: escaped HTML with <mark> around words starting with a search word.
export function markHtml(text, ws, esc) {
  const s = String(text || '');
  if (!ws.length) return esc(s);
  let out = '', last = 0;
  for (const m of s.matchAll(/[\p{L}\p{N}]+/gu)) {
    const f = fold(m[0]);
    if (!ws.some((w) => f.startsWith(w))) continue;
    out += esc(s.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

// A short piece of the abstract around the first search word, for a metadata hit with no PDF snippet.
export function abstractSnippet(abstract, ws, span = 160) {
  const s = decodeEntities(abstract).replace(/\s+/g, ' ').trim();
  if (!s || !ws.length) return '';
  const f = fold(s);
  let at = -1;
  for (const w of ws) { const m = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').exec(f); if (m && (at < 0 || m.index < at)) at = m.index + m[1].length; }
  if (at < 0) return '';
  const from = Math.max(0, at - 50);
  return `${from ? '…' : ''}${s.slice(from, from + span).replace(/^\S*\s/, from ? '' : '$&')}${from + span < s.length ? '…' : ''}`;
}

// Search tips shown under an empty box: [example, what it does, text a tap puts in the box].
export const HELP = [
  ['"exact phrase"', 'words in this order', '"'], ['a OR b', 'either word', 'OR '], ['-word', 'leave a word out', '-'],
  ['tag:airway  or  #airway', 'shared tag', 'tag:'], ['author:lee', 'any author', 'author:'], ['journal:anaesthesia', 'journal', 'journal:'],
  ['year:2018-2024  year:>2020', 'year or range', 'year:'], ['is:starred  is:presented  is:mine', '', 'is:'],
  ['has:pdf  has:slides  has:abstract  has:doi', '', 'has:'], ['in:title  in:abstract  in:pdf  in:notes', 'where the words must be', 'in:'],
];
