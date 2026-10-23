import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../worker/index.js';
import { fixtureFetch } from './fixture-fetch.js';

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

function bucket() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
    async put(k, v, o) { store.set(k, v); this.meta = o; }, async delete(k) { store.delete(k); } };
}

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

test('upload of a closed paper as "CC licensed" is refused', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/closed?basis=cc', 'mem1', { method: 'PUT', body: PDF }), env, W);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /no Creative Commons licence/);
  assert.equal(env.FILES.store.size, 0);
});

test('upload with no basis is refused', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/open', 'mem1', { method: 'PUT', body: PDF }), env, W);
  assert.equal(r.status, 403);
});

test('CC-BY paper uploads, and members read it back', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/open?basis=cc', 'mem1', { method: 'PUT', body: PDF }), env, W);
  assert.equal(r.status, 200);
  assert.equal(env.FILES.meta.customMetadata.license, 'cc-by');
  const g = await api(req('/api/file/open', 'mem2'), env, W);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Content-Type'), 'application/pdf');
  assert.equal((await api(req('/api/file/open'), env, W)).status, 401);
});

test('own material uploads; only the adder or an admin may upload or delete', async () => {
  const env = { FILES: bucket() };
  assert.equal((await api(req('/api/file/closed?basis=own', 'mem2', { method: 'PUT', body: PDF }), env, W)).status, 403);
  assert.equal((await api(req('/api/file/closed?basis=own', 'mem1', { method: 'PUT', body: PDF }), env, W)).status, 200);
  assert.equal((await api(req('/api/file/closed', 'mem2', { method: 'DELETE' }), env, W)).status, 403);
  assert.equal((await api(req('/api/file/closed', 'adm', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal(env.FILES.store.size, 0);
});

test('non-PDF bodies are refused', async () => {
  const env = { FILES: bucket() };
  const r = await api(req('/api/file/closed?basis=own', 'mem1', { method: 'PUT', body: 'hello' }), env, W);
  assert.equal(r.status, 415);
});

test('missing R2 binding gives a clear 503', async () => {
  assert.equal((await api(req('/api/file/open', 'mem1'), {}, W)).status, 503);
});
