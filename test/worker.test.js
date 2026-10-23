import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, parseRange } from '../worker/index.js';
import { fixtureFetch } from './fixture-fetch.js';
import { r2Stub } from './r2-stub.js';

const tokenFor = (uid) => `x.${btoa(JSON.stringify({ user_id: uid })).replace(/=+$/, '')}.sig`;
const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF');

// Firestore REST stand-in: members and papers, read with the caller's token.
function world({ members = {}, papers = {} } = {}) {
  const lookups = fixtureFetch();
  return async (url, init) => {
    const fs = /\/documents\/(members|papers)\/([^/?]+)$/.exec(url);
    if (!fs) return lookups(url, init);
    const auth = init?.headers?.Authorization || '';
    const caller = Object.keys(members).find((u) => auth === `Bearer ${tokenFor(u)}`);
    if (!caller) return new Response('{}', { status: 403 });
    const [, col, id] = fs;
    if (col === 'members' && id !== caller) return new Response('{}', { status: 403 });
    const row = (col === 'members' ? members : papers)[id];
    if (!row) return new Response('{}', { status: 404 });
    const fields = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { stringValue: v }]));
    return new Response(JSON.stringify({ fields }), { status: 200 });
  };
}

const bucket = r2Stub;

const W = world({
  members: { mem1: { role: 'member' }, mem2: { role: 'member' }, adm: { role: 'admin' } },
  papers: {
    open: { doi: '10.1371/journal.pmed.0020124', addedBy: 'mem1' },
    closed: { doi: '10.1056/nejmoa1305889', addedBy: 'mem1' },
  },
});
const req = (path, uid, init = {}) => new Request('https://jc.test' + path, {
  ...init, headers: { ...(uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {}), ...(init.headers || {}) },
});

test('API refuses callers who are not members', async () => {
  const env = { FILES: bucket() };
  assert.equal((await api(req('/api/lookup?id=16060722'), env, W)).status, 401);
  assert.equal((await api(req('/api/lookup?id=16060722', 'stranger'), env, W)).status, 401);
});

test('lookup through the Worker', async () => {
  const r = await api(req('/api/lookup?id=10.1371/journal.pmed.0020124', 'mem2'), {}, W);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).oa.license, 'cc-by');
});

test('any paper uploads with no licence check, and members read it back', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/closed', 'mem1', { method: 'PUT', body: PDF }), env, W);
  assert.equal(r.status, 200);
  assert.equal(env.FILES.meta.customMetadata.uploadedBy, 'mem1');
  const g = await api(req('/api/file/closed', 'mem2'), env, W);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Content-Type'), 'application/pdf');
  assert.equal((await api(req('/api/file/closed'), env, W)).status, 401);
});

test('only the adder or an admin may upload or delete', async () => {
  const env = { FILES: bucket() };
  assert.equal((await api(req('/api/file/closed', 'mem2', { method: 'PUT', body: PDF }), env, W)).status, 403);
  assert.equal((await api(req('/api/file/closed', 'mem1', { method: 'PUT', body: PDF }), env, W)).status, 200);
  assert.equal((await api(req('/api/file/closed', 'mem2', { method: 'DELETE' }), env, W)).status, 403);
  assert.equal((await api(req('/api/file/closed', 'adm', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal(env.FILES.store.size, 0);
});

test('non-PDF bodies are refused', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/closed', 'mem1', { method: 'PUT', body: 'hello' }), env, W);
  assert.equal(r.status, 415);
});

test('missing R2 binding gives a clear 503', async () => {
  assert.equal((await api(req('/api/file/open', 'mem1'), {}, W)).status, 503);
});

test('parseRange handles open, closed, suffix, oversize and bad ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { offset: 900, length: 100 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { offset: 900, length: 100 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { offset: 990, length: 10 });
  assert.equal(parseRange('bytes=1000-', 1000), null);
  assert.equal(parseRange('bytes=5-2', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), undefined);
  assert.equal(parseRange(null, 1000), undefined);
});

test('PDF GET honours Range with 206, HEAD gives the size, ETag gives 304, bad range gives 416', async () => {
  const env = { FILES: bucket() };
  const body = new TextEncoder().encode('%PDF-1.4\n' + 'x'.repeat(991));
  assert.equal((await api(req('/api/file/closed', 'mem1', { method: 'PUT', body }), env, W)).status, 200);

  const full = await api(req('/api/file/closed', 'mem2'), env, W);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(full.headers.get('Cache-Control'), 'private, max-age=86400');
  assert.equal(full.headers.get('Content-Length'), '1000');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);

  const part = await api(req('/api/file/closed', 'mem2', { headers: { Range: 'bytes=0-255' } }), env, W);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 0-255/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 256);

  const tail = await api(req('/api/file/closed', 'mem2', { headers: { Range: 'bytes=-10' } }), env, W);
  assert.equal(tail.headers.get('Content-Range'), 'bytes 990-999/1000');

  const head = await api(req('/api/file/closed', 'mem2', { method: 'HEAD' }), env, W);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '1000');

  const etag = full.headers.get('ETag');
  assert.ok(etag);
  assert.equal((await api(req('/api/file/closed', 'mem2', { headers: { 'If-None-Match': etag } }), env, W)).status, 304);

  assert.equal((await api(req('/api/file/closed', 'mem2', { headers: { Range: 'bytes=5000-' } }), env, W)).status, 416);
  assert.equal((await api(req('/api/file/nope', 'mem2', { headers: { Range: 'bytes=0-9' } }), env, W)).status, 404);
  assert.equal((await api(req('/api/file/closed', null, { headers: { Range: 'bytes=0-9' } }), env, W)).status, 401);
});
