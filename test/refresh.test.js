import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshId, refreshChanges } from '../src/refresh.js';

test('refreshId: doi, else pmid, else ATOTW number in the title, else none', () => {
  assert.equal(refreshId({ doi: '10.1/x', pmid: '1', title: 'ATOTW 551' }), '10.1/x');
  assert.equal(refreshId({ doi: '', pmid: '123', title: 't' }), '123');
  assert.equal(refreshId({ doi: '', pmid: '', title: 'ATOTW 551 SGLT2' }), '10.28923/atotw.551');
  assert.equal(refreshId({ doi: '', pmid: '', title: 'ward round handout' }), null);
});

test('refreshChanges: only changed bibliographic fields, doi/pmid only when newly found', () => {
  const stored = { title: 'T', journal: 'J', authors: ['A B'], abstract: 'Count 109/L', doi: '10.1/x', pmid: '', tags: ['t'], why: 'w' };
  const fresh = { title: 'T', journal: 'J', authors: ['A B'], abstract: 'Count 10⁹/L', doi: '10.9/other', pmid: '42', tags: ['x'], why: 'z', year: 2000 };
  assert.deepEqual(refreshChanges(stored, fresh), { abstract: 'Count 10⁹/L', pmid: '42' });
});

test('refreshChanges: nothing changed, and empty lookup values never overwrite', () => {
  const stored = { title: 'T', journal: 'J', authors: ['A'], abstract: 'x', doi: '10.1/x', pmid: '' };
  assert.deepEqual(refreshChanges(stored, { ...stored }), {});
  assert.deepEqual(refreshChanges(stored, { title: '', journal: '', authors: [], abstract: '', doi: '', pmid: '' }), {});
});
