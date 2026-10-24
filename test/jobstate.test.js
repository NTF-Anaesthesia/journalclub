import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveState, loadState, clearState, loadJobState, retrying, isTransient, retryStatus, httpError, RETRY_DELAYS, FAIL_RUN } from '../src/jobstate.js';

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('job state is saved per user, restored as saved, and cleared', () => {
  const st = memory();
  const s = { kind: 'fill', ids: ['b', 'c'], counts: { pdf: 1 }, missing: ['a'], total: 3, done: 1, started: 5 };
  saveState('u1', 'job', s, st);
  assert.deepEqual(loadJobState('u1', st), s);
  assert.equal(loadJobState('u2', st), null, 'another user on the same phone sees nothing');
  clearState('u1', 'job', st);
  assert.equal(loadJobState('u1', st), null);
});

test('a damaged or empty saved job is ignored', () => {
  const st = memory();
  st.setItem('jc-job:u1:job', '{not json');
  assert.equal(loadJobState('u1', st), null);
  saveState('u1', 'job', { kind: 'fill', ids: [] }, st);
  assert.equal(loadJobState('u1', st), null, 'nothing left to do');
  saveState('u1', 'job', { kind: 'fill', ids: ['x'] }, st);
  assert.deepEqual(loadJobState('u1', st), { kind: 'fill', ids: ['x'], counts: {}, missing: [], total: 1, done: 0 });
});

test('Rebuild keeps its cursor and running total', () => {
  const st = memory();
  saveState('u1', 'rebuild', { next: { phase: 'notes', pageToken: 'T' }, notes: 40 }, st);
  assert.deepEqual(loadState('u1', 'rebuild', st), { next: { phase: 'notes', pageToken: 'T' }, notes: 40 });
});

test('storage that throws never breaks a job', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
  saveState('u1', 'job', { kind: 'fill', ids: ['a'] }, bad);
  assert.equal(loadState('u1', 'job', bad), null);
  clearState('u1', 'job', bad);
});

test('network errors and 5xx are retried with backoff 2, 5, 15 s; other errors are not', async () => {
  assert.deepEqual(RETRY_DELAYS, [2000, 5000, 15000]);
  assert.equal(FAIL_RUN, 5);
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  let n = 0;
  assert.equal(await retrying(async () => { if (++n < 3) throw new TypeError('Failed to fetch'); return 'ok'; }, { sleep }), 'ok');
  assert.deepEqual(waits, [2000, 5000]);
  waits.length = 0; n = 0;
  await assert.rejects(retrying(async () => { n++; throw httpError({ status: 503 }); }, { sleep }), /HTTP 503/);
  assert.equal(n, 4, 'first try plus 3 retries');
  assert.deepEqual(waits, [2000, 5000, 15000]);
  n = 0;
  await assert.rejects(retrying(async () => { n++; throw new Error('bad input'); }, { sleep }), /bad input/);
  assert.equal(n, 1);
  assert.equal(isTransient(Object.assign(new Error('x'), { code: 'unavailable' })), true);
  assert.equal(isTransient(httpError({ status: 404 })), false);
});

test('a stop request ends the retries', async () => {
  let n = 0;
  await assert.rejects(retrying(async () => { n++; throw new TypeError('Failed to fetch'); }, { sleep: async () => {}, stopped: () => n >= 2 }));
  assert.equal(n, 2);
});

test('only real network failures, 429 and 5xx are transient', () => {
  for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) assert.equal(isTransient(new TypeError(m)), true, m);
  assert.equal(isTransient(new TypeError("Cannot read properties of undefined (reading 'x')")), false, 'a programming error fails the paper');
  assert.equal(isTransient(new TypeError('pdf.getPage is not a function')), false);
  assert.equal(isTransient(httpError({ status: 429 })), true);
  assert.equal(isTransient(httpError({ status: 502 })), true);
  assert.equal(isTransient(Object.assign(new Error('x'), { status: 0 })), true);
  assert.equal(isTransient(httpError({ status: 400 })), false);
  assert.equal(isTransient(new Error('Failed to fetch')), false, 'only a TypeError counts as fetch dropping');
  assert.deepEqual([200, 404, 429, 500].map(retryStatus), [false, false, true, true]);
});
