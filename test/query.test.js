import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, queryMatches, phrasesMatch, serverQuery, yearRange, suggest, lastToken, facets, markHtml, abstractSnippet } from '../src/query.js';
import { buildIndex, searchPapers } from '../src/search.js';

const papers = new Map([
  ['a', { title: 'Sugammadex versus neostigmine for reversal', authors: ['Ann Lee', 'Bo Müller'], journal: 'Anaesthesia', year: 2021, tags: ['reversal', 'airway'], abstract: 'Residual blockade after surgery was lower.', file: 'x', doi: '10.1/a', addedBy: 'u1', presented: [{ sid: 's1' }] }],
  ['b', { title: 'Post dural puncture headache in obstetrics', authors: ['Cara Tan'], journal: 'IJOA', year: 2015, tags: ['obstetric'], abstract: '' }],
  ['c', { title: 'Neostigmine dosing', authors: ['Dan Lee'], journal: 'BJA', year: 2024, tags: [], abstract: 'Dose finding.' }],
]);
const ids = (parsed, x = {}) => [...papers].filter(([id, p]) => queryMatches(id, p, parsed, x)).map(([id]) => id);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

test('parse: words, phrases, OR, exclusions, operators, #tag, scope', () => {
  const q = parseQuery('sugammadex OR neostigmine "dural puncture" -spinal tag:airway #obstetric -has:pdf year:2018-2024 in:title author:"van der" foo:bar');
  assert.deepEqual(q.groups.map((g) => g.map((t) => t.text)), [['sugammadex', 'neostigmine'], ['dural puncture'], ['foo:bar']]);
  assert.deepEqual(q.not.map((t) => t.text), ['spinal']);
  assert.deepEqual(q.filters.map((f) => [f.field, f.value, f.neg]), [['tag', 'airway', false], ['tag', 'obstetric', false], ['has', 'pdf', true], ['year', '2018-2024', false], ['author', 'van der', false]]);
  assert.equal(q.scope, 'title');
  assert.ok(q.text);
  assert.ok(parseQuery('').empty);
  assert.ok(!parseQuery('tag:airway').text);
  assert.ok(parseQuery('"unclosed phrase').groups[0][0].phrase);
});

test('years: single, ranges, open ends, comparisons', () => {
  assert.deepEqual(yearRange('2020'), [2020, 2020]);
  assert.deepEqual(yearRange('2018-2024'), [2018, 2024]);
  assert.deepEqual(yearRange('2018..'), [2018, Infinity]);
  assert.deepEqual(yearRange('>2020'), [2021, Infinity]);
  assert.deepEqual(yearRange('<=2015'), [-Infinity, 2015]);
  assert.equal(yearRange('soon'), null);
});

test('operators narrow by field, negated too; accents ignored', () => {
  assert.deepEqual(ids(parseQuery('tag:airway')), ['a']);
  assert.deepEqual(ids(parseQuery('-tag:airway')), ['b', 'c']);
  assert.deepEqual(ids(parseQuery('author:lee')), ['a', 'c']);
  assert.deepEqual(ids(parseQuery('author:muller')), ['a']);
  assert.deepEqual(ids(parseQuery('journal:anaes')), ['a']);
  assert.deepEqual(ids(parseQuery('year:>2020')), ['a', 'c']);
  assert.deepEqual(ids(parseQuery('has:pdf has:doi is:presented')), ['a']);
  assert.deepEqual(ids(parseQuery('has:abstract -has:pdf')), ['c']);
  assert.deepEqual(ids(parseQuery('is:starred'), { starred: new Set(['c']) }), ['c']);
  assert.deepEqual(ids(parseQuery('is:mine'), { uid: 'u1' }), ['a']);
  assert.deepEqual(ids(parseQuery('has:slides'), { slides: new Set(['b']) }), ['b']);
  assert.deepEqual(ids(parseQuery('-neostigmine')), ['b']);
  assert.deepEqual(ids(parseQuery('-"dural puncture"')), ['a', 'c']);
});

test('free words: OR, phrases and title scope through the phone index', () => {
  const ms = buildIndex(papers);
  const hits = (q) => searchPapers(ms, parseQuery(q)).map((h) => h.paperId).filter((id) => phrasesMatch(papers.get(id), parseQuery(q))).sort();
  assert.deepEqual(hits('sugammadex OR headache'), ['a', 'b']);
  assert.deepEqual(hits('neostigmine reversal'), ['a']);
  assert.deepEqual(hits('"dural puncture"'), ['b']);
  assert.deepEqual(hits('"puncture dural"'), []);
  assert.deepEqual(hits('dosing in:title'), ['c']);
  assert.deepEqual(hits('blockade in:title'), []);
  assert.deepEqual(hits('blockade in:abstract'), ['a']);
  assert.deepEqual(hits('blockade in:pdf'), []);
});

test('the Worker gets words, phrases, OR and -words only', () => {
  assert.equal(serverQuery(parseQuery('tag:airway sugammadex OR neostigmine "dural puncture" -spinal')), 'sugammadex OR neostigmine "dural puncture" -spinal');
  assert.equal(serverQuery(parseQuery('tag:airway')), '');
  assert.equal(serverQuery(parseQuery('word in:title')), '');
});

test('suggestions: field values, operator names, fixed values', () => {
  const f = facets([...papers]);
  assert.deepEqual(f.authors.slice(0, 1), [['Lee', 2]]);
  assert.deepEqual(suggest('tag:ai', f).map((s) => s.insert), ['tag:airway ']);
  assert.deepEqual(suggest('x -tag:ob', f).map((s) => s.label), ['-tag:obstetric']);
  assert.ok(suggest('le', f).some((s) => s.label === 'author:Lee'));
  assert.ok(suggest('aut', f).some((s) => s.insert === 'author:'));
  assert.deepEqual(suggest('has:s', f).map((s) => s.label), ['has:slides']);
  assert.deepEqual(lastToken('foo -tag:ai'), { start: 4, field: 'tag', partial: 'ai', neg: true });
  assert.equal(lastToken('foo ').partial, '');
});

test('marks search words in text and finds the abstract snippet', () => {
  assert.equal(markHtml('Neostigmine <dose>', ['neo'], esc), '<mark>Neostigmine</mark> &lt;dose>');
  assert.equal(markHtml('plain', [], esc), 'plain');
  assert.match(abstractSnippet('Residual blockade after surgery was lower.', ['blockade']), /blockade/);
  assert.equal(abstractSnippet('Nothing here', ['blockade']), '');
});
