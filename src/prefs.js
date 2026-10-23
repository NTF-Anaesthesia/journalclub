// Per-member state synced across devices: the Starred list (lists/star-<uid>, private), the last 20 papers
// opened (users/<uid>.recent), and the reading lists the member can see (their own plus every shared one).
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, serverTimestamp, arrayUnion, arrayRemove,
} from 'firebase/firestore';

const RECENT = 20;
let mine = { uid: null, starred: null, recent: null };
const reset = (uid) => { if (mine.uid !== uid) mine = { uid, starred: null, recent: null }; };
export const starId = (uid) => `star-${uid}`;

export async function loadStarred(db, uid) {
  reset(uid);
  if (!mine.starred) {
    const s = await getDoc(doc(db, 'lists', starId(uid))).catch(() => null);
    mine.starred = new Set(s?.exists() ? s.data().paperIds : []);
  }
  return mine.starred;
}

// Stars (on) or unstars papers; creates the member's Starred list the first time.
export async function setStarred(db, uid, ids, on) {
  const set = await loadStarred(db, uid);
  const ref = doc(db, 'lists', starId(uid));
  if (on) {
    const s = await getDoc(ref);
    if (!s.exists()) {
      await setDoc(ref, { name: 'Starred', about: '', paperIds: ids, createdBy: uid, createdAt: serverTimestamp(), visibility: 'private', kind: 'starred' });
    } else await updateDoc(ref, { paperIds: arrayUnion(...ids) });
    ids.forEach((id) => set.add(id));
  } else {
    await updateDoc(ref, { paperIds: arrayRemove(...ids) }).catch(() => {});
    ids.forEach((id) => set.delete(id));
  }
}

export async function loadRecent(db, uid) {
  reset(uid);
  if (!mine.recent) {
    const s = await getDoc(doc(db, 'users', uid)).catch(() => null);
    mine.recent = s?.exists() ? s.data().recent || [] : [];
  }
  return mine.recent;
}

export async function touchRecent(db, uid, id) {
  const r = await loadRecent(db, uid);
  if (r[0] === id) return;
  mine.recent = [id, ...r.filter((x) => x !== id)].slice(0, RECENT);
  await setDoc(doc(db, 'users', uid), { recent: mine.recent, updatedAt: serverTimestamp() }).catch(() => {});
}

// Lists this member sees: { id, ...data, mine, shared, starred }. Starred first, then the member's own, then shared.
// An admin's app also stamps lists from before visibility existed as shared, so members' queries find them.
export async function loadLists(db, uid, admin) {
  const col = collection(db, 'lists');
  const [own, shared] = await Promise.all([
    getDocs(query(col, where('createdBy', '==', uid))),
    getDocs(query(col, where('visibility', '==', 'shared'))),
  ]);
  if (admin) {
    const all = await getDocs(col).catch(() => null);
    const old = all ? all.docs.filter((d) => !d.data().visibility) : [];
    await Promise.all(old.map((d) => updateDoc(d.ref, { visibility: 'shared' }).catch(() => {})));
    if (old.length) return loadLists(db, uid, false);
  }
  const byId = new Map();
  for (const d of [...own.docs, ...shared.docs]) {
    const l = d.data();
    byId.set(d.id, { id: d.id, ...l, mine: l.createdBy === uid, shared: l.visibility !== 'private', starred: l.kind === 'starred' });
  }
  const rank = (l) => (l.starred ? 0 : l.mine ? 1 : 2);
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
// The Starred list is shown even before the member has starred anything.
export const starredStub = (uid) => ({ id: starId(uid), name: 'Starred', paperIds: [], mine: true, shared: false, starred: true, stub: true });
