// Per-member state synced across devices: the Starred list (lists/star-<uid>, private), the last 20 papers
// opened (users/<uid>.recent), and the member's private reading lists. Everything shared is a tag on the paper.
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

// The member's own lists: { id, ...data, mine, starred }, Starred first. Lists are private; shared groups are tags.
export async function loadLists(db, uid, admin) {
  const col = collection(db, 'lists');
  if (admin && !converted) { converted = true; await sharedListsToTags(db).catch((e) => { converted = false; console.error(e); }); }
  const own = await getDocs(query(col, where('createdBy', '==', uid)));
  const lists = own.docs.map((d) => ({ id: d.id, ...d.data(), mine: true, starred: d.data().kind === 'starred' }));
  return lists.sort((a, b) => (b.starred - a.starred) || a.name.localeCompare(b.name));
}

let converted = false; // once per app load
// Shared lists are retired: an admin's app turns each one (or one from before visibility existed) into a shared tag
// named after it on every paper in it, then makes the list private to its maker, who keeps it.
const listTag = (name) => String(name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
async function sharedListsToTags(db) {
  const all = await getDocs(collection(db, 'lists'));
  for (const d of all.docs) {
    const l = d.data();
    if (l.kind === 'starred' || l.visibility === 'private') continue;
    const tag = listTag(l.name);
    for (const pid of tag ? l.paperIds || [] : []) {
      const p = await getDoc(doc(db, 'papers', pid)).catch(() => null);
      const tags = p?.exists() ? p.data().tags || [] : null;
      if (tags && !tags.includes(tag) && tags.length < 20) await updateDoc(p.ref, { tags: [...tags, tag], changedAt: serverTimestamp() });
    }
    await updateDoc(d.ref, { visibility: 'private' });
  }
}
// The Starred list is shown even before the member has starred anything.
export const starredStub = (uid) => ({ id: starId(uid), name: 'Starred', paperIds: [], mine: true, starred: true, stub: true });
