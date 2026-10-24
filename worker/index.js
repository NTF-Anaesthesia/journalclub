// Serves the static shell from ./public and the members-only API under /api/.
// /__/auth/ and /__/firebase/ are proxied to the Firebase auth helper so sign-in runs on this origin
// (authDomain in src/config.js): redirect sign-in then works in installed web apps and with partitioned storage.
//
// API calls carry the member's Firebase ID token. The Worker holds no service account: it reads the
// member's own row (and a paper) from the Firestore REST API with that token, so Firestore checks the
// token and the rules decide, exactly as in the browser.
import { lookup } from './lookup.js';
import { cleanPages, indexPages, indexNotes, removeFromIndex, search, indexedPapers, firstPages } from './search.js';
import { enrich } from './enrich.js';
import { MAX_SLIDES, pullUrls, pull, storeSlides, serveSlides, deleteSlides } from './slides.js';

const AUTH_HELPER = 'https://journalclub-anantf.firebaseapp.com';
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/journalclub-anantf/databases/(default)/documents';
const MAX_PDF = 25 * 1024 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function tokenUid(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4))).user_id || null;
  } catch { return null; }
}

const field = (doc, name) => {
  const v = doc?.fields?.[name];
  return v ? (v.stringValue ?? v.integerValue ?? v.booleanValue ?? null) : null;
};

// The caller's member row, read as the caller. A forged uid fails because the rules only let a
// person read their own row, and Firestore rejects a forged token.
export async function memberFrom(request, fetchFn) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '')?.[1];
  const uid = token && tokenUid(token);
  if (!uid || !/^[A-Za-z0-9]{1,128}$/.test(uid)) return null;
  const r = await fetchFn(`${FIRESTORE}/members/${uid}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const doc = await r.json();
  return { uid, token, role: field(doc, 'role') };
}

async function docAs(member, path, fetchFn) {
  const r = await fetchFn(`${FIRESTORE}/${path}`, { headers: { Authorization: `Bearer ${member.token}` } });
  return r.ok ? r.json() : null;
}
const paperAs = (member, paperId, fetchFn) => docAs(member, `papers/${paperId}`, fetchFn);
const getAs = docAs;const docId = (d) => d.name.split('/').pop();

// The shared notes on one paper, read as the caller. A private note (shared is not true) is never indexed, not even
// for its writer, so search shows the same notes to everyone. The query filters on shared == true because the rules
// refuse a list that could include another member's private note.
async function noteTexts(member, paperId, fetchFn) {
  const r = await fetchFn(`${FIRESTORE}/papers/${paperId}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${member.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'notes' }], limit: 300,
      where: { fieldFilter: { field: { fieldPath: 'shared' }, op: 'EQUAL', value: { booleanValue: true } } },
    } }),
  });
  if (!r.ok) throw new Error('Could not read the notes');
  return (await r.json()).map((x) => x.document && field(x.document, 'text')).filter(Boolean);
}

// Admin, one batch per call so a call stays within the Worker's free-plan limit of 50 subrequests (D1 queries count
// too): 1 list + BACKFILL_PAGE note queries + one D1 batch per paper, about 21 for 10 papers. Indexes every paper's shared notes. The old "texts" phase is gone: it copied stale Firestore pages over
// newer D1 text, so a cursor that still says "texts" simply starts the notes phase.
const BACKFILL_PAGE = 10;
async function backfill(member, env, body, fetchFn) {
  const token = body.phase === 'notes' && typeof body.pageToken === 'string' ? `&pageToken=${encodeURIComponent(body.pageToken)}` : '';
  const out = await getAs(member, `papers?pageSize=${BACKFILL_PAGE}&mask.fieldPaths=title${token}`, fetchFn);
  if (!out) return json({ error: 'Could not read the papers' }, 502);
  const docs = out.documents || [];
  let indexed = 0;
  for (let i = 0; i < docs.length; i += 5) {
    await Promise.all(docs.slice(i, i + 5).map(async (d) => {
      const texts = await noteTexts(member, docId(d), fetchFn).catch(() => null);
      if (!texts) return; // could not read: leave the row as it is
      await indexNotes(env.SEARCH, docId(d), texts); // no shared notes clears the row
      if (texts.length) indexed++;
    }));
  }
  return json({ phase: 'notes', indexed, next: out.nextPageToken ? { phase: 'notes', pageToken: out.nextPageToken } : null });
}

async function searchApi(request, url, env, member, fetchFn) {
  if (!env.SEARCH) return json({ error: 'Search is not set up yet' }, 503);
  if (url.pathname === '/api/search' && request.method === 'GET') {
    try {
      return json({ hits: await search(env.SEARCH, (url.searchParams.get('q') || '').slice(0, 200)) });
    } catch { return json({ error: 'PDF search unavailable right now' }, 503); }
  }
  if (url.pathname === '/api/indexed' && request.method === 'GET') return json({ ids: await indexedPapers(env.SEARCH) });
  if (url.pathname === '/api/backfill' && request.method === 'POST') {
    if (member.role !== 'admin') return json({ error: 'Admins only' }, 403);
    return backfill(member, env, await request.json().catch(() => ({})), fetchFn);
  }
  const fp = /^\/api\/firstpage\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (fp) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (member.role !== 'admin') return json({ error: 'Admins only' }, 403);
    if (!(await paperAs(member, fp[1], fetchFn))) return json({ error: 'No such paper' }, 404);
    return json({ pages: await firstPages(env.SEARCH, fp[1], 1) });
  }
  const en = /^\/api\/enrich\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (en) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (member.role !== 'admin') return json({ error: 'Admins only' }, 403);
    const paper = await paperAs(member, en[1], fetchFn);
    if (!paper) return json({ error: 'No such paper' }, 404);
    const body = await request.json().catch(() => ({}));
    const pages = await firstPages(env.SEARCH, en[1]);
    const out = await enrich({ pages, paper: { title: field(paper, 'title') || '', doi: field(paper, 'doi') || '', atotw: Number(field(paper, 'atotw')) || null }, fetchFn,
      email: env.CONTACT_EMAIL || 'journalclub@anantf.com', ai: body.ai ? env.AI : null });
    return json(out);
  }
  const m = /^\/api\/index\/([A-Za-z0-9_-]{1,64})(\/notes)?$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const [, paperId, notes] = m;
  if (/^(deck|sess)_/.test(paperId)) return json({ error: 'Not found' }, 404); // slide text keys (slidesApi)
  const paper = await paperAs(member, paperId, fetchFn);
  if (!paper) return json({ error: 'No such paper' }, 404);
  // Any member may refresh the notes row: its text comes from Firestore, not from the caller.
  if (notes && request.method === 'POST') {
    let texts;
    try { texts = await noteTexts(member, paperId, fetchFn); } catch { return json({ error: 'Could not read the notes' }, 502); }
    await indexNotes(env.SEARCH, paperId, texts);
    return json({ ok: true });
  }
  if (notes) return json({ error: 'Method not allowed' }, 405);
  const mayEdit = member.role === 'admin' || field(paper, 'addedBy') === member.uid;
  if (!mayEdit) return json({ error: 'Only the person who added the paper, or an admin, can change its search text' }, 403);
  if (request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > 4 * 1024 * 1024) return json({ error: 'Too much text' }, 413);
    const pages = cleanPages((await request.json().catch(() => ({}))).pages);
    if (!pages) return json({ error: 'Send { pages: [text of page 1, …] }' }, 400);
    return json({ ok: true, pages: await indexPages(env.SEARCH, paperId, pages) });
  }
  if (request.method === 'DELETE') {
    await removeFromIndex(env.SEARCH, paperId);
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}

// Slide files: session slides (/api/slides/<session>) and teaching decks (/api/decks/<deck>). Any member reads them;
// a session's creator, presenter, coordinator and admins change its slides until it is locked; a deck's maker and admins
// change the deck. `/text` takes the slides' page text for search, kept in D1 as sess_<session> or deck_<deck> (paper
// ids are Firestore auto ids, which never hold "_").
const SLIDE_OWNERS = {
  slides: { col: 'sessions', dir: 'slides', key: 'sess_', what: 'session',
    may: (s, m) => m.role === 'admin' || ([field(s, 'createdBy'), field(s, 'presenterUid'), field(s, 'coordinatorUid')].includes(m.uid) && !field(s, 'locked')),
    refuse: 'Only the creator, presenter, coordinator or an admin can change the slides' },
  decks: { col: 'decks', dir: 'decks', key: 'deck_', what: 'deck',
    may: (d, m) => m.role === 'admin' || field(d, 'createdBy') === m.uid,
    refuse: 'Only the person who added the deck, or an admin, can change it' },
};

async function slidesApi(request, env, member, kind, sid, which, fetchFn) {
  const o = SLIDE_OWNERS[kind];
  if (!env.FILES) return json({ error: 'File storage is not set up yet' }, 503);
  const base = `${o.dir}/${sid}`;
  if (request.method === 'GET' && (which === 'pdf' || which === 'original')) return serveSlides(env, base, which);
  if (which && which !== 'text') return json({ error: 'Not found' }, 404);
  const s = await docAs(member, `${o.col}/${sid}`, fetchFn);
  if (!s) return json({ error: `No such ${o.what}` }, 404);
  if (!o.may(s, member)) return json({ error: o.refuse }, 403);
  if (which === 'text') {
    if (!env.SEARCH) return json({ error: 'Search is not set up yet' }, 503);
    if (request.method === 'DELETE') { await removeFromIndex(env.SEARCH, o.key + sid); return json({ ok: true }); }
    if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
    if (Number(request.headers.get('Content-Length') || 0) > 4 * 1024 * 1024) return json({ error: 'Too much text' }, 413);
    const pages = cleanPages((await request.json().catch(() => ({}))).pages);
    if (!pages) return json({ error: 'Send { pages: [text of slide 1, …] }' }, 400);
    return json({ ok: true, pages: await indexPages(env.SEARCH, o.key + sid, pages) });
  }
  if (request.method === 'DELETE') {
    await deleteSlides(env, base);
    if (env.SEARCH) await removeFromIndex(env.SEARCH, o.key + sid);
    return json({ ok: true });
  }
  if (request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > MAX_SLIDES) return json({ error: 'Slides are over 50 MB' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_SLIDES) return json({ error: 'Slides are over 50 MB' }, 413);
    let name = 'slides';
    try { name = decodeURIComponent(request.headers.get('X-File-Name') || 'slides'); } catch { /* keep the default */ }
    const out = await storeSlides(env, base, member.uid, body, name, fetchFn);
    return json(out.body, out.status);
  }
  if (request.method === 'POST') {
    const { url } = await request.json().catch(() => ({}));
    const src = pullUrls(String(url || ''));
    if (!src) return json({ error: 'The link must start with https://' }, 400);
    const got = await pull(src.file, fetchFn);
    if (got?.tooBig) return json({ error: 'Slides are over 50 MB' }, 413);
    const cannot = 'Could not pull the slides from that link. Share it as "Anyone with the link can view", or upload the file.';
    if (!got) return json({ error: cannot }, 422);
    const pdf = src.pdf ? await pull(src.pdf, fetchFn) : null;
    const out = await storeSlides(env, base, member.uid, got.buf, src.name || got.name, fetchFn, pdf?.buf);
    return out.status === 415 ? json({ error: cannot }, 422) : json(out.body, out.status);
  }
  return json({ error: 'Method not allowed' }, 405);
}

export async function api(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  const member = await memberFrom(request, fetchFn);
  if (!member) return json({ error: 'Members only' }, 401);
  const email = env.CONTACT_EMAIL || 'journalclub@anantf.com';

  if (url.pathname === '/api/lookup' && request.method === 'GET') {
    const out = await lookup(url.searchParams.get('id'), fetchFn, email);
    return json(out, out.error ? 404 : 200);
  }

  if (['/api/search', '/api/backfill', '/api/indexed'].includes(url.pathname) || url.pathname.startsWith('/api/index/') || url.pathname.startsWith('/api/enrich/') || url.pathname.startsWith('/api/firstpage/')) {
    return searchApi(request, url, env, member, fetchFn);
  }
  const sl = /^\/api\/(slides|decks)\/([A-Za-z0-9_-]{1,64})(?:\/(pdf|original|text))?$/.exec(url.pathname);
  if (sl) return slidesApi(request, env, member, sl[1], sl[2], sl[3], fetchFn);

  const m = /^\/api\/file\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const paperId = m[1];
  const key = `papers/${paperId}.pdf`;
  if (!env.FILES) return json({ error: 'File storage is not set up yet' }, 503);

  if (request.method === 'GET' || request.method === 'HEAD') return serveFile(request, env.FILES, key);

  const paper = await paperAs(member, paperId, fetchFn);
  if (!paper) return json({ error: 'No such paper' }, 404);
  const mayEdit = member.role === 'admin' || field(paper, 'addedBy') === member.uid;
  if (!mayEdit) return json({ error: 'Only the person who added the paper, or an admin, can change its file' }, 403);

  if (request.method === 'DELETE') {
    await env.FILES.delete(key);
    if (env.SEARCH) await removeFromIndex(env.SEARCH, paperId, { pdfOnly: true });
    return json({ ok: true });
  }

  if (request.method === 'PUT') {
    if (Number(request.headers.get('Content-Length') || 0) > MAX_PDF) return json({ error: 'PDF is over 25 MB' }, 413);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PDF) return json({ error: 'PDF is over 25 MB' }, 413);
    const head = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(5, body.byteLength)));
    if (head !== '%PDF-') return json({ error: 'Not a PDF' }, 415);
    await env.FILES.put(key, body, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { uploadedBy: member.uid },
    });
    return json({ ok: true, size: body.byteLength });
  }
  return json({ error: 'Method not allowed' }, 405);
}

// "bytes=a-b", "bytes=a-" or "bytes=-n" against a file of `size` bytes: {offset, length}; null when unsatisfiable;
// undefined when not a single bytes range (the whole file is sent).
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

// Paper PDFs: Range (206), HEAD and ETag so the reader can show page 1 before the whole file arrives and revisits are
// cheap. The browser may keep a copy for a day; removal clears the app's own caches, a stale HTTP copy can outlive it.
async function serveFile(request, files, key) {
  const head = await files.head(key);
  if (!head) return json({ error: 'No file' }, 404);
  const etag = head.httpEtag || (head.etag ? `"${head.etag}"` : '');
  const base = {
    'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400', ...(etag ? { ETag: etag } : {}),
  };
  if (etag && request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: base });
  const range = parseRange(request.headers.get('Range'), head.size);
  if (range === null) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${head.size}` } });
  if (request.method === 'HEAD') return new Response(null, { headers: { ...base, 'Content-Length': String(head.size) } });
  const obj = await files.get(key, range ? { range } : undefined);
  if (!obj) return json({ error: 'No file' }, 404);
  if (!range) return new Response(obj.body, { headers: { ...base, 'Content-Length': String(head.size) } });
  return new Response(obj.body, { status: 206, headers: {
    ...base, 'Content-Length': String(range.length), 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
  } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__/auth/') || url.pathname.startsWith('/__/firebase/')) {
      return fetch(new Request(AUTH_HELPER + url.pathname + url.search, request));
    }
    if (url.pathname.startsWith('/api/')) return api(request, env);
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    return new Response(res.body, { status: res.status, headers: h });
  },
};
