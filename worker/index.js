// Serves the static shell from ./public and the members-only API under /api/.
// /__/auth/ and /__/firebase/ are proxied to the Firebase auth helper so sign-in runs on this origin
// (authDomain in src/config.js): redirect sign-in then works in installed web apps and with partitioned storage.
//
// API calls carry the member's Firebase ID token. The Worker holds no service account: it reads the
// member's own row (and a paper) from the Firestore REST API with that token, so Firestore checks the
// token and the rules decide, exactly as in the browser.
import { lookup } from './lookup.js';

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

async function paperAs(member, paperId, fetchFn) {
  const r = await fetchFn(`${FIRESTORE}/papers/${paperId}`, { headers: { Authorization: `Bearer ${member.token}` } });
  return r.ok ? r.json() : null;
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

  const m = /^\/api\/file\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) return json({ error: 'Not found' }, 404);
  const paperId = m[1];
  const key = `papers/${paperId}.pdf`;
  if (!env.FILES) return json({ error: 'File storage is not set up yet' }, 503);

  if (request.method === 'GET') {
    const obj = await env.FILES.get(key);
    if (!obj) return json({ error: 'No file' }, 404);
    return new Response(obj.body, { headers: {
      'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline',
    } });
  }

  const paper = await paperAs(member, paperId, fetchFn);
  if (!paper) return json({ error: 'No such paper' }, 404);
  const mayEdit = member.role === 'admin' || field(paper, 'addedBy') === member.uid;
  if (!mayEdit) return json({ error: 'Only the person who added the paper, or an admin, can change its file' }, 403);

  if (request.method === 'DELETE') {
    await env.FILES.delete(key);
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
