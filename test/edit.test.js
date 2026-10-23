import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForm, editChanges } from '../src/edit.js';

const form = (o = {}) => ({ title: 'T', authors: 'A B\n C D \n', journal: ' J ', year: '2020', doi: 'https://doi.org/10.1/ABC', pmid: 'PMID: 123', abstract: ' text ', tags: 'Airway, airway, exam', why: ' w ', ...o });

test('parseForm trims, splits authors, strips DOI and PMID prefixes, lowercases the DOI, dedupes tags', () => {
  const p = parseForm(form());
  assert.deepEqual(p.values, { title: 'T', authors: ['A B', 'C D'], journal: 'J', year: 2020, doi: '10.1/abc', pmid: '123', abstract: 'text' });
  assert.deepEqual(p.tags, ['airway', 'exam']);
  assert.equal(p.why, 'w');
  assert.equal(parseForm(form({ year: '' })).values.year, null);
});

test('parseForm refuses bad input with a reason', () => {
  assert.match(parseForm(form({ title: '  ' })).error, /title/);
  assert.match(parseForm(form({ year: '99' })).error, /year/);
  assert.match(parseForm(form({ year: '20x0' })).error, /year/);
  assert.match(parseForm(form({ doi: 'abc' })).error, /DOI/);
  assert.match(parseForm(form({ pmid: '12ab' })).error, /PubMed/);
  assert.match(parseForm(form({ abstract: 'x'.repeat(20001) })).error, /abstract/);
});

test('editChanges writes only what changed, flags it manual, and marks a typed abstract', () => {
  const p = { title: 'T', authors: ['A B', 'C D'], journal: 'J', year: 2020, doi: '10.1/ABC', pmid: '123', abstract: 'text', tags: ['airway', 'exam'], why: 'w' };
  assert.deepEqual(editChanges(p, parseForm(form())), {});
  const ch = editChanges(p, parseForm(form({ title: 'New', abstract: 'mine' })));
  assert.deepEqual(ch, { title: 'New', abstract: 'mine', abstractSource: 'hand', manual: ['title', 'abstract'] });
  const more = editChanges({ ...p, manual: ['title'] }, parseForm(form({ year: '2021', tags: 'x', why: '' })));
  assert.deepEqual(more, { year: 2021, manual: ['title', 'year'], tags: ['x'], why: '' });
});
