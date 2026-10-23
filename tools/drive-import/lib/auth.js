// Firebase sign-in without a person: a service-account key (a local file, never in a repo) lets firebase-admin mint a
// custom token for the member "libraryimport", which Identity Toolkit swaps for an ID token the Worker accepts like any
// member's. Firestore writes use the admin SDK directly. firebase-admin is only loaded here, so tests don't need it.
import { readFileSync } from 'node:fs';

export const IMPORT_UID = 'libraryimport';
const EXCHANGE = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=';

export async function connect({ keyPath, apiKey, fetchFn = fetch }) {
  const admin = (await import('firebase-admin')).default;
  const sa = JSON.parse(readFileSync(keyPath, 'utf8'));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const ts = () => admin.firestore.FieldValue.serverTimestamp();

  await db.doc(`members/${IMPORT_UID}`).set({ name: 'Library import', role: 'admin', email: '', inviteId: null, joinedAt: ts() }, { merge: true });

  let token = null, expires = 0;
  async function idToken() {
    if (token && Date.now() < expires - 5 * 60 * 1000) return token;
    const custom = await admin.auth().createCustomToken(IMPORT_UID);
    const r = await fetchFn(EXCHANGE + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
    });
    if (!r.ok) throw new Error(`sign-in failed (${r.status})`);
    const j = await r.json();
    token = j.idToken;
    expires = Date.now() + Number(j.expiresIn || 3600) * 1000;
    return token;
  }
  return { db, ts, idToken, projectId: sa.project_id };
}
