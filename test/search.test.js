import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../worker/index.js';
import { ftsQuery, cleanPages, resetSchemaCache, MARK } from '../worker/search.js';
import { localD1 } from './d1.js';

const tokenFor = (uid) => `x.${btoa(JSON.stringify({ user_id: uid })).replace(/=+$/, '')}.sig`;
const str = (v) => ({ stringValue: v });

// Firestore REST stand-in: members, papers, their notes and the old texts/<paper> docs, read with the caller's token.
function world({ members, papers, notes = {}, texts = {} }) {
  const page = (items, url, mk) => {
    const u = new URL(url);
    const size = Number(u.searchParams.get('pageSize')), from = Number(u.searchParams.get('pageToken') || 0);
    const slice = items.slice(from, from + size);
    return { documents: slice.map(mk), ...(from + size < items.length ? { nextPageToken: String(from + size) } : {}) };
  };
  const doc = (path, fields) => ({ name: `projects/p/databases/(default)/documents/${path}`, fields });
  return async (url, init) => {
    const auth = init?.headers?.Authorization || '';
    const caller = Object.keys(members).find((u) => auth === `Bearer ${tokenFor(u)}`);
    if (!caller) return new Response('{}', { status: 403 });
    const path = new URL(url).pathname.split('/documents/')[1];
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    let m;
    if ((m = /^members\/([^/]+)$/.exec(path))) {
      return m[1] === caller ? ok(doc(path, { role: str(members[caller].role) })) : new Response('{}', { status: 403 });
    }
    if ((m = /^papers\/([^/:]+)$/.exec(path))) {
      return papers[m[1]] ? ok(doc(path, { addedBy: str(papers[m[1]].addedBy) })) : new Response('{}', { status: 404 });
    }
    // Notes: a plain string is a shared note, { private } is a private one. As under the rules, a list that could
    // include another member's private note is refused; only a query filtered on shared == true is answered.
    if ((m = /^papers\/([^/]+)\/notes$/.exec(path))) return new Response('{}', { status: 403 });
    if ((m = /^papers\/([^/]+):runQuery$/.exec(path))) {
      const f = JSON.parse(init.body).structuredQuery.where?.fieldFilter;
      if (!(f?.field.fieldPath === 'shared' && f.op === 'EQUAL' && f.value.booleanValue === true)) return new Response('{}', { status: 403 });
      return ok((notes[m[1]] || []).filter((t) => typeof t === 'string')
        .map((t, i) => ({ document: doc(`papers/${m[1]}/notes/u${i}`, { text: str(t), shared: { booleanValue: true } }) })));
    }
    if (path === 'papers') return ok(page(Object.keys(papers), url, (id) => doc(`papers/${id}`, {})));
    if (path === 'texts') {
      return ok(page(Object.entries(texts), url, ([id, pages]) => doc(`texts/${id}`, { pages: { arrayValue: { values: pages.map(str) } } })));
    }
    return new Response('{}', { status: 404 });
  };
}

const members = { mem1: { role: 'member' }, mem2: { role: 'member' }, adm: { role: 'admin' } };
const papers = { p1: { addedBy: 'mem1' }, p2: { addedBy: 'mem2' }, p3: { addedBy: 'mem1' } };
const req = (path, uid, init = {}) => new Request('https://jc.test' + path, {
  ...init, headers: { ...(uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {}), ...(init.headers || {}) },
});
const putPages = (id, uid, pages) => req(`/api/index/${id}`, uid, { method: 'PUT', body: JSON.stringify({ pages }) });
const find = async (env, W, q, uid = 'mem2') => (await (await api(req(`/api/search?q=${encodeURIComponent(q)}`, uid), env, W)).json()).hits;
const plain = (s) => s.replaceAll(MARK[0], '[').replaceAll(MARK[1], ']');

let d1;
before(async () => { d1 = await localD1(); });
after(async () => { await d1?.dispose(); });

test('query words become quoted prefix terms; punctuation cannot break out', () => {
  assert.equal(ftsQuery('Sugammadex, rocuronium!'), '"sugammadex"* "rocuronium"*');
  assert.equal(ftsQuery('" OR 1=1 --'), '"or"* "1"*');
  assert.equal(ftsQuery('  '), null);
  assert.equal(ftsQuery('sugammadex OR neostigmine reversal'), '("sugammadex"* OR "neostigmine"*) "reversal"*');
  assert.equal(ftsQuery('"post dural" -spinal'), '("post dural") NOT ("spinal"*)');
  assert.equal(ftsQuery('-only'), null);
  assert.equal(cleanPages(['a', 3]), null);
  assert.deepEqual(cleanPages([' a\n b ']), ['a b']);
});

test('upload text, then any member finds the page with a snippet', async () => {
  const W = world({ members, papers });
  const env = { SEARCH: d1.db };
  const r = await api(putPages('p1', 'mem1', ['Intro page', 'Sugammadex reverses rocuronium quickly in adults', '']), env, W);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).pages, 2);
  const hits = await find(env, W, 'rocuronium');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].paperId, 'p1');
  assert.equal(hits[0].page, 2);
  assert.match(plain(hits[0].snippet), /\[rocuronium\]/);
  // Prefix and stemmed forms.
  assert.equal((await find(env, W, 'sugamm'))[0].page, 2);
  assert.equal((await find(env, W, 'reverse'))[0].page, 2);
  // Words must all match.
  assert.equal((await find(env, W, 'rocuronium ketamine')).length, 0);
  // Re-uploading replaces the old pages.
  await api(putPages('p1', 'mem1', ['Ketamine only now']), env, W);
  assert.equal((await find(env, W, 'rocuronium')).length, 0);
  assert.equal((await find(env, W, 'ketamine'))[0].page, 1);
});

test('only the adder or an admin writes PDF text; strangers cannot search', async () => {
  const W = world({ members, papers });
  const env = { SEARCH: d1.db };
  assert.equal((await api(putPages('p1', 'mem2', ['x']), env, W)).status, 403);
  assert.equal((await api(putPages('p1', 'adm', ['Admin wrote propofol']), env, W)).status, 200);
  assert.equal((await api(putPages('nope', 'adm', ['x']), env, W)).status, 404);
  assert.equal((await api(putPages('p1', 'mem1', 'not a list'), env, W)).status, 400);
  assert.equal((await api(req('/api/search?q=propofol', 'stranger'), env, W)).status, 401);
  assert.equal((await api(req('/api/search?q=propofol'), env, W)).status, 401);
  assert.equal((await api(req('/api/search?q=propofol', 'mem2'), {}, W)).status, 503);
});

test('notes are indexed from Firestore, not from the caller, and found as page 0', async () => {
  const W = world({ members, papers, notes: { p2: ['Good on epidural fever'], p3: ['Remifentanil PCA'] } });
  const env = { SEARCH: d1.db };
  const r = await api(req('/api/index/p2/notes', 'mem1', { method: 'POST', body: JSON.stringify({ text: 'ignored' }) }), env, W);
  assert.equal(r.status, 200);
  const hits = await find(env, W, 'epidural');
  assert.deepEqual(hits.map((h) => [h.paperId, h.page]), [['p2', 0]]);
  assert.equal((await find(env, W, 'ignored')).length, 0);
  // A paper hit in both its notes and its PDF reports the PDF page.
  await api(putPages('p2', 'mem2', ['Nothing', 'Epidural fever and sepsis']), env, W);
  assert.deepEqual((await find(env, W, 'epidural')).map((h) => [h.paperId, h.page]), [['p2', 2]]);
});

test('private notes are never indexed, and a note switched to private leaves the index', async () => {
  const env = { SEARCH: d1.db };
  const notes = { p1: ['Shared note about caudal blocks', { private: 'Private musings on zebrafish' }] };
  const W = world({ members, papers, notes });
  assert.equal((await api(req('/api/index/p1/notes', 'mem1', { method: 'POST' }), env, W)).status, 200);
  assert.deepEqual((await find(env, W, 'caudal')).map((h) => [h.paperId, h.page]), [['p1', 0]]);
  for (const uid of ['mem1', 'mem2', 'adm']) assert.equal((await find(env, W, 'zebrafish', uid)).length, 0);
  // The only shared note goes private: a refresh clears the paper's notes row.
  notes.p1 = [{ private: 'Shared note about caudal blocks' }];
  assert.equal((await api(req('/api/index/p1/notes', 'mem1', { method: 'POST' }), env, W)).status, 200);
  assert.equal((await find(env, W, 'caudal')).length, 0);
  // The admin backfill also clears a row whose notes are all private.
  await api(req('/api/index/p1/notes', 'mem1', { method: 'POST' }), env, world({ members, papers, notes: { p1: ['Stale shared'] } }));
  assert.equal((await find(env, W, 'stale')).length, 1);
  await api(req('/api/backfill', 'adm', { method: 'POST', body: JSON.stringify({ phase: 'notes' }) }), env, W);
  assert.equal((await find(env, W, 'stale')).length, 0);
});

test('the first schema run clears notes indexed before notes could be private, once', async () => {
  const db = (await localD1());
  try {
    const { ensureSchema } = await import('../worker/search.js');
    await ensureSchema(db.db);
    await db.db.batch([db.db.prepare("INSERT INTO page_text (paper, page, text) VALUES ('x1', 0, 'old private note'), ('x1', 1, 'pdf page')"),
      db.db.prepare("DELETE FROM search_meta WHERE k = 'notes_shared_only'")]);
    resetSchemaCache();
    await ensureSchema(db.db);
    assert.deepEqual((await db.db.prepare('SELECT page FROM page_text WHERE paper = ?').bind('x1').all()).results.map((r) => r.page), [1]);
    await db.db.prepare("INSERT INTO page_text (paper, page, text) VALUES ('x1', 0, 'shared note')").run();
    resetSchemaCache();
    await ensureSchema(db.db);
    assert.equal((await db.db.prepare('SELECT count(*) AS n FROM page_text WHERE paper = ? AND page = 0').bind('x1').first()).n, 1);
  } finally { await db.dispose(); }
});

test('removing the PDF drops its pages; removing the paper drops everything', async () => {
  const W = world({ members, papers, notes: { p3: ['Remifentanil PCA notes'] } });
  const files = new Map([['papers/p3.pdf', 'x']]);
  const env = { SEARCH: d1.db, FILES: { async delete(k) { files.delete(k); } } };
  await api(putPages('p3', 'mem1', ['Remifentanil in labour']), env, W);
  await api(req('/api/index/p3/notes', 'mem2', { method: 'POST' }), env, W);
  assert.equal((await find(env, W, 'remifentanil'))[0].page, 1);
  assert.equal((await api(req('/api/file/p3', 'mem1', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal((await find(env, W, 'remifentanil'))[0].page, 0);
  assert.equal((await api(req('/api/index/p3', 'mem2', { method: 'DELETE' }), env, W)).status, 403);
  assert.equal((await api(req('/api/index/p3', 'mem1', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal((await find(env, W, 'remifentanil')).length, 0);
});

test('admin backfill indexes notes only, 25 papers per call, and ignores old texts cursors', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
  const bpapers = { ...papers, ...Object.fromEntries(ids.map((id) => [id, { addedBy: 'mem1' }])) };
  // Stale Firestore pages must never reach D1: Rebuild no longer copies texts/*.
  const texts = Object.fromEntries(ids.map((id) => [id, ['Cover', `Stale word zygomatic${id}`]]));
  const W = world({ members, papers: bpapers, texts, notes: { b11: ['Noted tranexamic'], b29: ['Noted lastpage'] } });
  const env = { SEARCH: d1.db };
  const call = (body, uid = 'adm') => api(req('/api/backfill', uid, { method: 'POST', body: JSON.stringify(body) }), env, W);
  assert.equal((await call({}, 'mem1')).status, 403);
  // An old cursor in phase "texts" just starts the notes phase.
  assert.equal((await (await call({ phase: 'texts', pageToken: 'stale' })).json()).phase, 'notes');
  let body = {}, calls = 0, indexed = 0;
  while (body) {
    const r = await call(body);
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.phase, 'notes');
    indexed += out.indexed; calls++;
    body = out.next;
  }
  assert.ok(calls >= 2, 'notes go 25 per call');
  assert.equal(indexed, 2);
  assert.equal((await find(env, W, 'tranexamic'))[0].paperId, 'b11');
  assert.equal((await find(env, W, 'lastpage'))[0].paperId, 'b29');
  assert.equal((await find(env, W, 'zygomatic')).length, 0, 'texts/* is not copied');
  // Running it again changes nothing.
  body = {};
  while (body) body = (await (await call(body)).json()).next;
  assert.equal((await find(env, W, 'tranexamic')).length, 1);
});

test('GET /api/indexed lists papers with PDF pages indexed (notes alone do not count), members only', async () => {
  const W = world({ members, papers, notes: { p2: ['Only a note here'] } });
  const env = { SEARCH: d1.db };
  for (const id of ['p1', 'p2', 'p3']) await api(req(`/api/index/${id}`, 'adm', { method: 'DELETE' }), env, W);
  await api(putPages('p1', 'mem1', ['Indexed page']), env, W);
  await api(req('/api/index/p2/notes', 'mem1', { method: 'POST' }), env, W);
  const r = await api(req('/api/indexed', 'mem2'), env, W);
  assert.equal(r.status, 200);
  const got = (await r.json()).ids; // the D1 is shared with the tests above (backfill papers b*)
  assert.ok(got.includes('p1'));
  assert.ok(!got.includes('p2') && !got.includes('p3'));
  assert.equal((await api(req('/api/indexed', 'stranger'), env, W)).status, 401);
  assert.equal((await api(req('/api/indexed', 'mem2'), {}, W)).status, 503);
});

test('a D1 error on search answers 503 with a plain message', async () => {
  const W = world({ members, papers });
  const broken = { batch: async () => { throw new Error('D1 over its limit'); }, prepare: () => { throw new Error('D1 over its limit'); } };
  resetSchemaCache();
  const r = await api(req('/api/search?q=propofol', 'mem2'), { SEARCH: broken }, W);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'PDF search unavailable right now');
  resetSchemaCache();
});
