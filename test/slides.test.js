import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../worker/index.js';
import { slideKind, pullUrls } from '../worker/slides.js';

const tokenFor = (uid) => `x.${btoa(JSON.stringify({ user_id: uid })).replace(/=+$/, '')}.sig`;
const enc = (s) => new TextEncoder().encode(s);
const PDF = enc('%PDF-1.4\n%%EOF');
const PPTX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc('....ppt/presentation.xml....')]);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...enc('....word/document.xml....')]);
const PPT = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

const members = { pres: 'member', mem2: 'member', adm: 'admin' };
const sessions = {
  s1: { createdBy: 'mem2', presenterUid: 'pres' },
  lk: { createdBy: 'pres', presenterUid: 'pres', locked: true },
};
const decks = { d1: { createdBy: 'pres' } };

// Firestore REST, CloudConvert and share-link hosts, all faked. `calls` records outside fetches.
function world({ links = {}, cc = true } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const fs = /\/documents\/(members|sessions|decks)\/([^/?]+)$/.exec(url);
    if (fs) {
      const caller = Object.keys(members).find((u) => init.headers?.Authorization === `Bearer ${tokenFor(u)}`);
      if (!caller) return new Response('{}', { status: 403 });
      const [, col, id] = fs;
      if (col === 'members') {
        return id === caller ? Response.json({ fields: { role: { stringValue: members[id] } } }) : new Response('{}', { status: 403 });
      }
      const row = (col === 'decks' ? decks : sessions)[id];
      if (!row) return new Response('{}', { status: 404 });
      return Response.json({ fields: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }])) });
    }
    calls.push(url);
    if (url === 'https://api.cloudconvert.com/v2/jobs') {
      if (!cc) return new Response('{}', { status: 401 });
      return Response.json({ data: { id: 'j1', tasks: [{ name: 'up', result: { form: { url: 'https://upload.cc/x', parameters: { k: 'v' } } } }] } });
    }
    if (url === 'https://upload.cc/x') return new Response('', { status: 201 });
    if (url === 'https://sync.api.cloudconvert.com/v2/jobs/j1') {
      return Response.json({ data: { status: 'finished', tasks: [{ name: 'out', result: { files: [{ url: 'https://out.cc/s.pdf' }] } }] } });
    }
    if (url === 'https://out.cc/s.pdf') return new Response(PDF);
    if (links[url]) return new Response(links[url].body, { headers: links[url].headers || {} });
    return new Response('<html>sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  fn.calls = calls;
  return fn;
}

function bucket() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? { body: store.get(k).v, ...store.get(k).o } : null; },
    async put(k, v, o) { store.set(k, { v, o }); }, async delete(k) { store.delete(k); } };
}
const req = (path, uid, init = {}) => new Request('https://jc.test' + path, {
  ...init, headers: { ...(uid ? { Authorization: `Bearer ${tokenFor(uid)}` } : {}), ...(init.headers || {}) },
});
const put = (sid, uid, body, name) => req(`/api/slides/${sid}`, uid, { method: 'PUT', body, headers: name ? { 'X-File-Name': encodeURIComponent(name) } : {} });
const post = (sid, uid, url) => req(`/api/slides/${sid}`, uid, { method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' } });

test('file kinds are told by their bytes', () => {
  assert.equal(slideKind(PDF), 'pdf');
  assert.equal(slideKind(PPTX), 'pptx');
  assert.equal(slideKind(PPT), 'ppt');
  assert.equal(slideKind(DOCX), null);
  assert.equal(slideKind(enc('<html>')), null);
});

test('share links become download links', () => {
  assert.deepEqual(pullUrls('https://docs.google.com/presentation/d/AbC_1-x/edit?usp=sharing'), {
    file: 'https://docs.google.com/presentation/d/AbC_1-x/export/pptx', pdf: 'https://docs.google.com/presentation/d/AbC_1-x/export/pdf', name: 'slides.pptx' });
  assert.equal(pullUrls('https://drive.google.com/file/d/F1/view?usp=share_link').file, 'https://drive.google.com/uc?export=download&id=F1');
  assert.equal(pullUrls('https://www.dropbox.com/scl/fi/abc/talk.pptx?rlkey=k&dl=0').file, 'https://www.dropbox.com/scl/fi/abc/talk.pptx?rlkey=k&dl=1');
  assert.equal(pullUrls('https://nhg-my.sharepoint.com/:p:/g/personal/x/EAbc?e=1').file, 'https://nhg-my.sharepoint.com/:p:/g/personal/x/EAbc?e=1&download=1');
  assert.equal(pullUrls('http://example.org/a.pdf'), null);
  assert.equal(pullUrls('javascript:alert(1)'), null);
});

test('a PDF upload is stored once and any member opens it', async () => {
  const env = { FILES: bucket() }; const W = world();
  const r = await api(put('s1', 'pres', PDF, 'My talk.pdf'), env, W);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'My talk.pdf', size: PDF.byteLength, kind: 'pdf', pdf: true });
  assert.deepEqual([...env.FILES.store.keys()], ['slides/s1/pdf']);
  const g = await api(req('/api/slides/s1/pdf', 'mem2'), env, W);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('Content-Type'), 'application/pdf');
  assert.equal((await api(req('/api/slides/s1/pdf'), env, W)).status, 401);
  assert.equal(W.calls.length, 0);
});

test('a PowerPoint upload keeps the original and a CloudConvert PDF', async () => {
  const env = { FILES: bucket(), CLOUDCONVERT_KEY: 'k' }; const W = world();
  const r = await api(put('s1', 'mem2', PPTX, 'Talk.pptx'), env, W);
  assert.deepEqual(await r.json(), { name: 'Talk.pptx', size: PPTX.byteLength, kind: 'pptx', pdf: true });
  assert.equal(env.FILES.store.get('slides/s1/pdf').o.customMetadata.name, 'Talk.pdf');
  const o = await api(req('/api/slides/s1/original', 'pres'), env, W);
  assert.match(o.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''Talk\.pptx$/);
  assert.match(o.headers.get('Content-Type'), /presentationml/);
});

test('if conversion fails the PowerPoint is still saved, with a warning', async () => {
  const env = { FILES: bucket(), CLOUDCONVERT_KEY: 'bad' };
  const out = await (await api(put('s1', 'pres', PPT, 'old.ppt'), env, world({ cc: false }))).json();
  assert.equal(out.kind, 'ppt');
  assert.equal(out.pdf, false);
  assert.ok(out.warning);
  assert.deepEqual([...env.FILES.store.keys()], ['slides/s1/original']);
});

test('only the creator, presenter or an admin change slides, and not once locked', async () => {
  const env = { FILES: bucket() }; const W = world();
  sessions.s2 = { createdBy: 'pres', presenterUid: 'pres' };
  assert.equal((await api(put('s2', 'mem2', PDF), env, W)).status, 403);
  assert.equal((await api(put('lk', 'pres', PDF), env, W)).status, 403);
  assert.equal((await api(put('lk', 'adm', PDF), env, W)).status, 200);
  assert.equal((await api(put('none', 'adm', PDF), env, W)).status, 404);
  assert.equal((await api(req('/api/slides/lk', 'mem2', { method: 'DELETE' }), env, W)).status, 403);
  assert.equal((await api(req('/api/slides/lk', 'adm', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal(env.FILES.store.size, 0);
});

test('other files are refused', async () => {
  const env = { FILES: bucket() };
  assert.equal((await api(put('s1', 'pres', DOCX), env, world())).status, 415);
  assert.equal((await api(put('s1', 'pres', enc('hello')), env, world())).status, 415);
});

test('a Google Slides link is pulled with its own PDF, no conversion', async () => {
  const env = { FILES: bucket(), CLOUDCONVERT_KEY: 'k' };
  const W = world({ links: {
    'https://docs.google.com/presentation/d/G1/export/pptx': { body: PPTX },
    'https://docs.google.com/presentation/d/G1/export/pdf': { body: PDF },
  } });
  const out = await (await api(post('s1', 'pres', 'https://docs.google.com/presentation/d/G1/edit'), env, W)).json();
  assert.deepEqual(out, { name: 'slides.pptx', size: PPTX.byteLength, kind: 'pptx', pdf: true });
  assert.equal(W.calls.some((u) => u.includes('cloudconvert')), false);
});

test('a direct link keeps its file name; a private link is refused', async () => {
  const env = { FILES: bucket() };
  const W = world({ links: { 'https://www.dropbox.com/s/x/deck.pdf?dl=1': {
    body: PDF, headers: { 'Content-Disposition': 'attachment; filename="deck.pdf"' } } } });
  const out = await (await api(post('s1', 'pres', 'https://www.dropbox.com/s/x/deck.pdf?dl=0'), env, W)).json();
  assert.equal(out.name, 'deck.pdf');
  const r = await api(post('s1', 'pres', 'https://docs.google.com/presentation/d/PRIVATE/edit'), env, W);
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /Anyone with the link/);
  assert.equal((await api(post('s1', 'pres', 'http://x.org/a.pdf'), env, W)).status, 400);
});

// D1 stand-in for the slide text: records what was indexed and removed.
function searchDb() {
  const rows = new Map();
  const db = { rows, prepare(q) { return { q, bind(...a) { this.a = a; return this; }, async run() { if (/^DELETE/.test(q)) { for (const k of [...rows.keys()]) if (k === this.a[0]) rows.delete(k); } return {}; } }; },
    async batch(st) { for (const x of st) { if (/^DELETE/.test(x.q)) rows.delete(x.a?.[0]); if (/^INSERT INTO page_text/.test(x.q)) rows.set(x.a[0], (rows.get(x.a[0]) || 0) + x.a.length / 3); } return []; } };
  return db;
}

test('teaching decks: the maker or an admin uploads, any member opens, the slide text is indexed as deck_<id>', async () => {
  const env = { FILES: bucket(), SEARCH: searchDb() }; const W = world();
  const up = (uid) => req('/api/decks/d1', uid, { method: 'PUT', body: PDF, headers: { 'X-File-Name': encodeURIComponent('Airway talk.pdf') } });
  assert.equal((await api(up('mem2'), env, W)).status, 403);
  assert.equal((await api(up('pres'), env, W)).status, 200);
  assert.deepEqual([...env.FILES.store.keys()], ['decks/d1/pdf']);
  assert.equal((await api(req('/api/decks/d1/pdf', 'mem2'), env, W)).status, 200);
  assert.equal((await api(req('/api/decks/nope', 'adm', { method: 'PUT', body: PDF }), env, W)).status, 404);
  const text = (uid) => req('/api/decks/d1/text', uid, { method: 'PUT', body: JSON.stringify({ pages: ['Difficult airway', '', 'Front of neck'] }), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await api(text('mem2'), env, W)).status, 403);
  const t = await api(text('adm'), env, W);
  assert.equal(t.status, 200);
  assert.equal((await t.json()).pages, 2);
  assert.equal(env.SEARCH.rows.get('deck_d1'), 2);
  assert.equal((await api(req('/api/decks/d1', 'pres', { method: 'DELETE' }), env, W)).status, 200);
  assert.equal(env.FILES.store.size, 0);
  assert.equal(env.SEARCH.rows.has('deck_d1'), false);
});

test('session slide text is indexed as sess_<id> by those who may change the slides', async () => {
  const env = { FILES: bucket(), SEARCH: searchDb() }; const W = world();
  const text = (sid, uid) => req(`/api/slides/${sid}/text`, uid, { method: 'PUT', body: JSON.stringify({ pages: ['Sugammadex'] }), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await api(text('s1', 'pres'), env, W)).status, 200);
  assert.equal(env.SEARCH.rows.get('sess_s1'), 1);
  assert.equal((await api(text('lk', 'pres'), env, W)).status, 403);
  // A paper id that looks like a slide key cannot reach the paper index.
  assert.equal((await api(req('/api/index/deck_d1', 'adm', { method: 'PUT', body: '{}' }), env, W)).status, 404);
});
