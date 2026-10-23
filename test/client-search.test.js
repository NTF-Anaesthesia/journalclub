import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, updateIndex, searchPapers, mergeHits } from '../src/search.js';

const papers = new Map([
  ['a', { title: 'Sugammadex versus neostigmine', authors: ['A Lee'], tags: ['reversal'], abstract: 'SpO&#x2082; fell' }],
  ['b', { title: 'Epidural fever', authors: ['B Tan'], tags: ['obstetric'] }],
]);

test('phone index covers metadata only, with typos, and updates in place', () => {
  const ms = buildIndex(papers);
  assert.deepEqual(searchPapers(ms, 'sugamadex').map((h) => h.paperId), ['a']);
  assert.deepEqual(searchPapers(ms, 'obstetric').map((h) => h.paperId), ['b']);
  assert.deepEqual(searchPapers(ms, 'spo₂').map((h) => h.paperId), ['a']);
  updateIndex(ms, 'b', { title: 'Spinal headache', tags: [] });
  assert.equal(searchPapers(ms, 'epidural').length, 0);
  assert.deepEqual(searchPapers(ms, 'spinal').map((h) => h.paperId), ['b']);
  updateIndex(ms, 'b', null);
  assert.equal(searchPapers(ms, 'spinal').length, 0);
});

test('metadata hits first and take the server page and snippet; server-only hits follow; unknown ids dropped', () => {
  const local = [{ paperId: 'a', page: null, snippet: null }];
  const server = [{ paperId: 'b', page: 3, snippet: 'x' }, { paperId: 'a', page: 2, snippet: 'y' }, { paperId: 'gone', page: 1, snippet: 'z' }];
  assert.deepEqual(mergeHits(local, server, (id) => papers.has(id)), [
    { paperId: 'a', page: 2, snippet: 'y' }, { paperId: 'b', page: 3, snippet: 'x' },
  ]);
});
