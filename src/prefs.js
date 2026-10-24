// Per-member state synced across devices: the Starred list (lists/star-<uid>, private), the last 20 papers
// opened (users/<uid>.recent), saved searches (users/<uid>.searches), and the member's private reading lists. Everything shared is a tag on the paper.
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, serverTimestamp, arrayUnion, arrayRemove, deleteField,
} from 'firebase/firestore';

const RECENT = 20;
const SEARCHES = 20;
let mine = { uid: null, starred: null, recent: null, searches: null, noted: null, scan: null };
const reset = (uid) => { if (mine.uid !== uid) mine = { uid, starred: null, recent: null, searches: null, noted: null, scan: null }; };
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

// One read of users/<uid> fills both Recent and saved searches.
let userRead = null;
async function readUser(db, uid) {
  if (!userRead || userRead.uid !== uid) {
    userRead = { uid, p: getDoc(doc(db, 'users', uid)).then((s) => (s.exists() ? s.data() : {}), (e) => { userRead = null; throw e; }) };
  }
  return userRead.p;
}

// Which papers the member has a note on: users/<uid>.noted = { paperId: updatedAt in ms }. It lets the Library mark rows
// and Saved list the notes without reading a note per paper. Notes written before the index existed are found once by
// scanNoted (users/<uid>.notedScan marks it done).
export async function loadNoted(db, uid) {
  reset(uid);
  if (!mine.noted) {
    const u = await readUser(db, uid).catch(() => ({}));
    mine.noted = { ...(u.noted || {}) }; mine.scanned = !!u.notedScan;
  }
  return mine.noted;
}

// Records (ms) or clears (null) the member's note on a paper.
export async function setNoted(db, uid, pid, ms) {
  const noted = await loadNoted(db, uid);
  const ref = doc(db, 'users', uid);
  if (ms == null) {
    delete noted[pid];
    await updateDoc(ref, { [`noted.${pid}`]: deleteField(), updatedAt: serverTimestamp() }).catch(() => {});
  } else {
    noted[pid] = ms;
    await setDoc(ref, { noted: { [pid]: ms }, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
  }
}

// Once per member: reads their own note doc on every paper (a few at a time) to fill the index from before it existed.
// Resolves with the index; a failure leaves the scan to run again next time.
export function scanNoted(db, uid, paperIds) {
  reset(uid);
  if (mine.scan) return mine.scan;
  mine.scan = (async () => {
    const noted = await loadNoted(db, uid);
    if (mine.scanned) return noted;
    const ids = [...paperIds];
    const found = {};
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(ids.slice(i, i + 10).map(async (pid) => {
        const s = await getDoc(doc(db, 'papers', pid, 'notes', uid));
        const d = s.exists() ? s.data() : null;
        if (d?.text) found[pid] = d.updatedAt?.toMillis ? d.updatedAt.toMillis() : Date.now();
      }));
    }
    Object.assign(noted, found);
    await setDoc(doc(db, 'users', uid), { noted: found, notedScan: Date.now(), updatedAt: serverTimestamp() }, { merge: true });
    mine.scanned = true;
    return noted;
  })().catch((e) => { mine.scan = null; throw e; });
  return mine.scan;
}

export async function loadRecent(db, uid) {
  reset(uid);
  if (!mine.recent) mine.recent = (await readUser(db, uid).catch(() => ({}))).recent || [];
  return mine.recent;
}

// Saved searches: the box text, newest first.
export async function loadSearches(db, uid) {
  reset(uid);
  if (!mine.searches) mine.searches = (await readUser(db, uid).catch(() => ({}))).searches || [];
  return mine.searches;
}

export async function setSearchSaved(db, uid, q, on) {
  const all = await loadSearches(db, uid);
  mine.searches = on ? [q, ...all.filter((s) => s !== q)].slice(0, SEARCHES) : all.filter((s) => s !== q);
  await setDoc(doc(db, 'users', uid), { searches: mine.searches, updatedAt: serverTimestamp() }, { merge: true });
  return mine.searches;
}

export async function touchRecent(db, uid, id) {
  const r = await loadRecent(db, uid);
  if (r[0] === id) return;
  mine.recent = [id, ...r.filter((x) => x !== id)].slice(0, RECENT);
  await setDoc(doc(db, 'users', uid), { recent: mine.recent, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
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
