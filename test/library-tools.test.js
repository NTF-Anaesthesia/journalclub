import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIPS, matches, chipCounts, tagCounts, sortEntries, discussedAt, selectAll, triState, emptyFilter, filterOn } from '../src/filters.js';
import { vancouver, vancouverList, bibtex } from '../src/cite.js';
import { findDuplicates, pickKeep, keepAllowed, mergePaper, mergeNotes, similarity, normTitle } from '../src/dupes.js';

const ts = (s) => ({ seconds: s });
const lib = [
  ['a', { title: 'The airway trial', authors: ['John Smith', 'Ann Lee'], year: 2020, doi: '10.1/a', abstract: 'x', tags: ['airway'], file: { pages: 3 }, addedAt: ts(1) }],
  ['b', { title: 'Blocks in obstetrics', authors: ['Zoe Adams'], year: 2024, doi: '', abstract: '', tags: [], addedAt: ts(3), presented: [{ sid: 's1' }] }],
  ['c', { title: 'Carbon cost of anaesthesia', authors: [], year: null, doi: '10.1/c', abstract: 'y', tags: ['airway', 'green'], file: { pages: 1 }, addedAt: ts(2) }],
];
const x = { starred: new Set(['b']), indexed: new Set(['a']), recent: ['c', 'b'] };
const ids = (e) => e.map(([id]) => id);

test('chips filter and count over the whole catalogue', () => {
  const f = emptyFilter();
  assert.equal(filterOn(f), false);
  f.chips.add('noAbstract');
  assert.deepEqual(ids(lib.filter(([id, p]) => matches(id, p, f, x))), ['b']);
  f.chips = new Set(['notIndexed']);
  assert.deepEqual(ids(lib.filter(([id, p]) => matches(id, p, f, x))), ['c'], 'has a PDF, no pages in D1');
  assert.equal(matches('c', lib[2][1], f, { ...x, indexed: null }), false, 'unknown until the Worker answers');
  f.chips = new Set(['starred']);
  assert.deepEqual(ids(lib.filter(([id, p]) => matches(id, p, f, x))), ['b']);
  const g = { ...emptyFilter(), tag: 'airway', yearFrom: 2021 };
  assert.deepEqual(ids(lib.filter(([id, p]) => matches(id, p, g, x))), [], 'tag AND year; no year never matches a range');
  assert.deepEqual(chipCounts(lib, x), { noAbstract: 1, noDoi: 1, noPdf: 1, notIndexed: 1, untagged: 1, starred: 1, presented: 1 });
  assert.equal(CHIPS.length, 7);
  assert.deepEqual(tagCounts(lib), [['airway', 2], ['green', 1]]);
});

test('recently discussed: latest past session first, planned ones ignored, rest newest added', () => {
  const day = 86400000, now = Date.UTC(2026, 9, 23);
  const L = [['a', { addedAt: { seconds: 1 }, presented: [{ sid: 's1', date: now - 30 * day }] }],
    ['b', { addedAt: { seconds: 9 } }],
    ['c', { addedAt: { seconds: 5 }, presented: [{ sid: 's2', date: now - 2 * day }, { sid: 's3', date: now + 7 * day }] }],
    ['d', { addedAt: { seconds: 7 }, presented: [{ sid: 's4', date: { toMillis: () => now + day } }] }]];
  assert.deepEqual(ids(sortEntries(L, 'discussed', { now })), ['c', 'a', 'b', 'd']);
  assert.equal(discussedAt(L[2][1], now), now - 2 * day);
});

test('sort orders; missing values last', () => {
  assert.deepEqual(ids(sortEntries(lib, 'newest')), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortEntries(lib, 'year')), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortEntries(lib, 'title')), ['a', 'b', 'c'], '"The" is ignored');
  assert.deepEqual(ids(sortEntries(lib, 'author')), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortEntries(lib, 'recent', x)), ['c', 'b', 'a']);
});

test('select all: loaded rows unless narrowed, then every match up to 200; tri-state', () => {
  const many = Array.from({ length: 250 }, (_, i) => `p${i}`);
  assert.deepEqual(selectAll(['p0', 'p1'], many, false), ['p0', 'p1']);
  assert.equal(selectAll(['p0'], many, true).length, 200);
  assert.equal(triState(['a', 'b'], (id) => id === 'a'), 'some');
  assert.equal(triState(['a', 'b'], () => true), 'all');
  assert.equal(triState(['a'], () => false), 'none');
});

test('Vancouver and BibTeX citations', () => {
  const p = { title: 'Why most published research findings are false', authors: ['John P. A. Ioannidis'], journal: 'PLoS Med', year: 2005, doi: '10.1371/journal.pmed.0020124' };
  assert.equal(vancouver(p), 'Ioannidis JPA. Why most published research findings are false. PLoS Med. 2005. doi:10.1371/journal.pmed.0020124');
  const seven = { ...p, authors: ['A One', 'B Two', 'C Three', 'D Four', 'E Five', 'F Six', 'G Seven'], title: 'Is it?' };
  assert.match(vancouver(seven), /^One A, Two B, Three C, Four D, Five E, Six F, et al\. Is it\? /);
  assert.equal(vancouverList([p, p]).split('\n')[1].slice(0, 3), '2. ');
  const bib = bibtex([p, { ...p, title: 'Second & more_' }]);
  assert.match(bib, /@article\{ioannidis2005,/);
  assert.match(bib, /@article\{ioannidis2005a,/);
  assert.match(bib, /author = \{Ioannidis, John P\. A\.\}/);
  assert.match(bib, /title = \{Second \\& more\\_\}/);
});

test('duplicates: same DOI, or near-identical long titles; merge keeps everything', () => {
  assert.equal(normTitle('Hip-fracture: A trial!'), 'hipfractureatrial');
  assert.ok(similarity('tranexamicacidinhipfracturesurgery', 'tranexamicacidinhipfracturesurgerys') > 0.92);
  const e = [
    ['p1', { title: 'Tranexamic acid in hip fracture surgery', doi: '10.9/X' }],
    ['p2', { title: 'Tranexamic acid in hip-fracture surgery.', doi: '' }],
    ['p3', { title: 'Something else entirely, a long title', doi: '10.9/x' }],
    ['p4', { title: 'Videolaryngoscopy versus direct laryngoscopy in adults' }],
    ['p5', { title: 'Videolaryngoscopy versus direct laryngoscopy in children' }],
    ['p6', { title: 'Editorial' }], ['p7', { title: 'Editorial' }],
  ];
  const g = findDuplicates(e);
  assert.deepEqual(g.map((x) => x.ids.sort()), [['p1', 'p2', 'p3']]);
  const withPdf = ['k', { file: { pages: 1 }, addedAt: ts(9) }], older = ['d', { addedAt: ts(1) }];
  assert.deepEqual(pickKeep(older, withPdf).map(([id]) => id), ['k', 'd']);
  assert.equal(keepAllowed({}, { file: {} }), false);
  const m = mergePaper({ tags: ['a'], presented: [{ sid: 's1' }], doi: '10.1/k' }, { tags: ['a', 'b'], why: 'w', presented: [{ sid: 's1' }, { sid: 's2' }], pmid: '9', abstract: 'abs', doi: '10.1/d' });
  assert.deepEqual(m.edit, { tags: ['a', 'b'], why: 'w' });
  assert.deepEqual(m.presented.map((s) => s.sid), ['s1', 's2']);
  assert.deepEqual(m.biblio, { pmid: '9', abstract: 'abs' });
  const n = mergeNotes([{ uid: 'u1', text: 'mine', rating: 2 }], [{ uid: 'u1', text: 'other', rating: 4 }, { uid: 'u2', text: 'new', rating: 0 }]);
  assert.deepEqual(n, [{ uid: 'u1', text: 'mine\n\nother', rating: 4 }, { uid: 'u2', text: 'new', rating: 0 }]);
});
