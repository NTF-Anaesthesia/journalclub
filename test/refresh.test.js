import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshId, refreshChanges, fillChanges } from '../src/refresh.js';

test('refreshId: doi, else pmid, else ATOTW number in the title, else none', () => {
  assert.equal(refreshId({ doi: '10.1/x', pmid: '1', title: 'ATOTW 551' }), '10.1/x');
  assert.equal(refreshId({ doi: '', pmid: '123', title: 't' }), '123');
  assert.equal(refreshId({ doi: '', pmid: '', title: 'ATOTW 551 SGLT2' }), '10.28923/atotw.551');
  assert.equal(refreshId({ doi: '', pmid: '', title: 'ward round handout' }), null);
});

test('refreshChanges: only changed bibliographic fields, doi/pmid only when newly found', () => {
  const stored = { title: 'T', journal: 'J', authors: ['A B'], abstract: 'Count 109/L', doi: '10.1/x', pmid: '', tags: ['t'], why: 'w' };
  const fresh = { title: 'T', journal: 'J', authors: ['A B'], abstract: 'Count 10⁹/L', doi: '10.9/other', pmid: '42', tags: ['x'], why: 'z', year: 2000 };
  assert.deepEqual(refreshChanges(stored, fresh), { abstract: 'Count 10⁹/L', abstractSource: 'lookup', pmid: '42' });
});

test('refreshChanges: nothing changed, and empty lookup values never overwrite', () => {
  const stored = { title: 'T', journal: 'J', authors: ['A'], abstract: 'x', doi: '10.1/x', pmid: '' };
  assert.deepEqual(refreshChanges(stored, { ...stored }), {});
  assert.deepEqual(refreshChanges(stored, { title: '', journal: '', authors: [], abstract: '', doi: '', pmid: '' }), {});
});

test('refreshChanges: fields typed by hand (manual) survive a refresh, the rest still update', () => {
  const stored = { title: 'My title', journal: 'J', authors: ['A'], abstract: 'My words', abstractSource: 'hand', doi: '', pmid: '', manual: ['title', 'abstract', 'doi'] };
  const fresh = { title: 'Their title', journal: 'J2', authors: ['A'], abstract: 'Their abstract', doi: '10.1/x', pmid: '9' };
  assert.deepEqual(refreshChanges(stored, fresh), { journal: 'J2', pmid: '9' });
});

test('fillChanges: fills only what is empty, never manual fields, never a real abstract', () => {
  const res = { via: 'pdf-doi', abstractSource: 'pdf', found: { doi: '10.1/x', pmid: '5', title: 'Real title', authors: ['A B'], journal: 'Anaesthesia', year: 2020, abstract: 'From the PDF' } };
  const bare = { title: 'scan 001', abstract: '', authors: [], journal: '', doi: '', pmid: '' };
  assert.deepEqual(fillChanges(bare, res), { title: 'Real title', doi: '10.1/x', pmid: '5', authors: ['A B'], journal: 'Anaesthesia', year: 2020,
    abstract: 'From the PDF', abstractSource: 'pdf' });
  assert.deepEqual(fillChanges({ ...bare, manual: ['title', 'abstract'] }, res).title, undefined);
  assert.equal(fillChanges({ ...bare, manual: ['abstract'] }, res).abstract, undefined);
  const kept = fillChanges({ ...bare, title: 'Mine', journal: 'J', year: 1999, abstract: 'Real one', abstractSource: 'lookup' }, res);
  assert.deepEqual(Object.keys(kept).sort(), ['authors', 'doi', 'pmid']);
});

test('fillChanges: a lookup abstract replaces an AI summary or PDF excerpt; a duplicate DOI is not written; a title match keeps the title', () => {
  const lookup = { via: 'pdf-doi', abstractSource: 'lookup', found: { doi: '10.1/x', title: 'T', abstract: 'Real abstract' } };
  assert.equal(fillChanges({ title: 'x', abstract: 'AI text', abstractSource: 'ai', journal: 'J', authors: ['A'] }, lookup).abstract, 'Real abstract');
  assert.equal(fillChanges({ title: 'x', abstract: 'Hand text', abstractSource: 'hand', journal: 'J', authors: ['A'] }, lookup).abstract, undefined);
  const dup = fillChanges({ title: 'x', abstract: '', authors: [], journal: '' }, lookup, new Set(['10.1/x']));
  assert.equal(dup.doi, undefined);
  assert.equal(dup.title, undefined);
  assert.equal(fillChanges({ title: 'x', abstract: '', authors: [], journal: '' }, { ...lookup, via: 'title' }).title, undefined);
});
