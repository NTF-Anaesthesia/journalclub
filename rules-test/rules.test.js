import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, collectionGroup, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp, query, where } from 'firebase/firestore';

let env;
const HOUR = 3600 * 1000;
const future = (ms = 24 * HOUR) => Timestamp.fromMillis(Date.now() + ms);
const past = () => Timestamp.fromMillis(Date.now() - HOUR);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-jc',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'members/admin1'), { email: 'a@x.org', name: 'A', role: 'admin', inviteId: 'seed' });
    await setDoc(doc(db, 'members/mem1'), { email: 'm@x.org', name: 'M', role: 'member', inviteId: 'seed' });
    await setDoc(doc(db, 'invites/good'), { createdBy: 'admin1', createdAt: new Date(), expiresAt: future(), used: false });
    await setDoc(doc(db, 'invites/old'), { createdBy: 'admin1', createdAt: new Date(), expiresAt: past(), used: false });
    await setDoc(doc(db, 'invites/spent'), { createdBy: 'admin1', createdAt: new Date(), expiresAt: future(), used: true, usedBy: 'mem1' });
  });
});

const as = (uid, email) => env.authenticatedContext(uid, { email }).firestore();
const stranger = () => env.unauthenticatedContext().firestore();

function redeem(db, uid, email, token) {
  const b = writeBatch(db);
  b.update(doc(db, 'invites', token), { used: true, usedBy: uid, usedAt: serverTimestamp() });
  b.set(doc(db, 'members', uid), { email, name: 'New', role: 'member', inviteId: token, joinedAt: serverTimestamp() });
  return b.commit();
}

test('member reads own row; non-member and signed-out cannot', async () => {
  await assertSucceeds(getDoc(doc(as('mem1', 'm@x.org'), 'members/mem1')));
  await assertFails(getDoc(doc(as('nobody', 'n@x.org'), 'members/mem1')));
  await assertFails(getDoc(doc(stranger(), 'members/mem1')));
});

test('member cannot read others or list the allow-list; admin can', async () => {
  await assertFails(getDoc(doc(as('mem1', 'm@x.org'), 'members/admin1')));
  await assertFails(getDocs(collection(as('mem1', 'm@x.org'), 'members')));
  await assertSucceeds(getDocs(collection(as('admin1', 'a@x.org'), 'members')));
});

test('valid invite lets a stranger join as member', async () => {
  await assertSucceeds(redeem(as('new1', 'n@x.org'), 'new1', 'n@x.org', 'good'));
  await assertSucceeds(getDoc(doc(as('new1', 'n@x.org'), 'members/new1')));
});

test('used invite cannot be redeemed again', async () => {
  await assertFails(redeem(as('new2', 'n2@x.org'), 'new2', 'n2@x.org', 'spent'));
});

test('expired invite cannot be redeemed', async () => {
  await assertFails(redeem(as('new3', 'n3@x.org'), 'new3', 'n3@x.org', 'old'));
});

test('signed-out person cannot redeem', async () => {
  await assertFails(redeem(stranger(), 'new4', 'n4@x.org', 'good'));
});

test('cannot join without consuming an invite, or as admin, or with a forged email', async () => {
  const db = as('new5', 'n5@x.org');
  await assertFails(setDoc(doc(db, 'members/new5'), { email: 'n5@x.org', name: 'x', role: 'member', inviteId: 'good', joinedAt: serverTimestamp() }));
  const b = writeBatch(db);
  b.update(doc(db, 'invites/good'), { used: true, usedBy: 'new5', usedAt: serverTimestamp() });
  b.set(doc(db, 'members/new5'), { email: 'n5@x.org', name: 'x', role: 'admin', inviteId: 'good', joinedAt: serverTimestamp() });
  await assertFails(b.commit());
  await assertFails(redeem(db, 'new5', 'someoneelse@x.org', 'good'));
});

test('cannot burn an invite for another uid', async () => {
  await assertFails(redeem(as('new6', 'n6@x.org'), 'other', 'n6@x.org', 'good'));
});

test('only admins create, list, delete invites', async () => {
  const inv = (uid) => ({ createdBy: uid, createdAt: serverTimestamp(), expiresAt: future(), used: false });
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'invites/n1'), inv('admin1')));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'invites/n2'), inv('mem1')));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'invites/n3'), { ...inv('admin1'), expiresAt: future(60 * 24 * HOUR) }));
  await assertFails(getDocs(collection(as('mem1', 'm@x.org'), 'invites')));
  await assertSucceeds(getDocs(collection(as('admin1', 'a@x.org'), 'invites')));
  await assertFails(deleteDoc(doc(as('mem1', 'm@x.org'), 'invites/good')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'invites/good')));
});

test('only admins change roles or remove members, never themselves', async () => {
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'members/mem1'), { role: 'admin' }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'members/mem1'), { role: 'admin' }));
  await assertFails(updateDoc(doc(as('admin1', 'a@x.org'), 'members/mem1'), { email: 'z@x.org' }));
  await assertFails(deleteDoc(doc(as('admin1', 'a@x.org'), 'members/admin1')));
  await assertFails(deleteDoc(doc(as('mem1', 'm@x.org'), 'members/mem1')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'members/mem1')));
});

test('unknown collections are closed', async () => {
  await assertFails(getDoc(doc(as('admin1', 'a@x.org'), 'other/x')));
});

const newPaper = (uid, extra = {}) => ({
  doi: '10.1/x', pmid: '', title: 'A trial', authors: ['A B'], journal: 'J', year: 2020, abstract: '',
  oa: { status: 'closed', license: null, url: null }, tags: ['airway'], why: 'good', addedBy: uid, addedAt: serverTimestamp(), ...extra,
});

test('changedAt, when sent, must be the server time on create and update', async () => {
  const m = as('mem1', 'm@x.org');
  await assertSucceeds(setDoc(doc(m, 'papers/c1'), newPaper('mem1', { changedAt: serverTimestamp() })));
  await assertFails(setDoc(doc(m, 'papers/c2'), newPaper('mem1', { changedAt: new Date(2020, 0, 1) })));
  await assertSucceeds(updateDoc(doc(m, 'papers/c1'), { tags: ['x'], changedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(m, 'papers/c1'), { tags: ['y'], changedAt: new Date(2099, 0, 1) }));
  await assertSucceeds(updateDoc(doc(m, 'papers/c1'), { why: 'no stamp' }));
});

test('admin refresh may rewrite bibliographic fields only; members and other fields cannot', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'papers/r1'),
    { ...newPaper('mem1'), addedAt: new Date(), doi: '', pmid: '' }));
  const a = doc(as('admin1', 'a@x.org'), 'papers/r1'), m = doc(as('mem1', 'm@x.org'), 'papers/r1');
  await assertSucceeds(updateDoc(a, { title: 'New', journal: 'J2', authors: ['C D'], abstract: '10⁹/L', doi: '10.2/y', pmid: '7' }));
  await assertSucceeds(updateDoc(a, { doi: '10.3/z' }));   // a wrong DOI can be corrected by hand (Refresh itself only fills an empty one: test/refresh.test.js)
  await assertFails(updateDoc(a, { title: '' }));
  await assertSucceeds(updateDoc(a, { year: 1999, abstractSource: 'pdf' })); // Fill missing details
  await assertFails(updateDoc(a, { title: 'N', addedBy: 'admin1' }));
  await assertFails(updateDoc(a, { title: 'N', file: null }));
  await assertFails(updateDoc(m, { addedBy: 'admin1', title: 'N' }));
});

test('Tidy ATOTW: only admins write the tutorial number (int 1-2000) with title, journal, year and manual', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'papers/t1'), { ...newPaper('mem1'), addedAt: new Date(), year: null }));
  const a = doc(as('admin1', 'a@x.org'), 'papers/t1'), m = doc(as('mem1', 'm@x.org'), 'papers/t1');
  await assertSucceeds(updateDoc(a, { title: 'The Shoulder Block', journal: 'Anaesthesia Tutorial of the Week', year: 2013, atotw: 453,
    manual: ['title', 'journal', 'year'], changedAt: serverTimestamp() }));
  await assertFails(updateDoc(a, { atotw: 0 }));
  await assertFails(updateDoc(a, { atotw: 2001 }));
  await assertFails(updateDoc(a, { atotw: '453' }));
  await assertFails(updateDoc(a, { atotw: 5, addedBy: 'admin1' }));
  await assertFails(updateDoc(a, { atotw: 5, tags: ['x'] }));
  await assertFails(updateDoc(m, { atotw: 7 })); // the adder is a member: no
  await assertFails(updateDoc(m, { atotw: 7, title: 'T', manual: ['title'] }));
  await assertFails(updateDoc(doc(as('nobody', 'n@x.org'), 'papers/t1'), { atotw: 7 }));
});

test('any member edits a paper\'s details by hand; fields are checked when they change; nothing else', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'papers/e1'), { ...newPaper('admin1'), addedAt: new Date(), year: null }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  const other = doc(as('mem2', 'm2@x.org'), 'papers/e1'); // not the adder
  await assertSucceeds(updateDoc(other, { title: 'Corrected title', authors: ['E F'], journal: 'Anaesthesia', year: 2021, doi: '10.9/new',
    pmid: '12345', abstract: 'Typed by hand', abstractSource: 'hand', manual: ['title', 'abstract'], changedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(other, { year: null }));
  await assertSucceeds(updateDoc(other, { doi: '' }));
  await assertSucceeds(updateDoc(other, { title: 'Again', tags: ['x'], why: 'w' }));
  await assertFails(updateDoc(other, { title: '' }));
  await assertFails(updateDoc(other, { title: 'x'.repeat(501) }));
  await assertFails(updateDoc(other, { year: 1700 }));
  await assertFails(updateDoc(other, { year: '2020' }));
  await assertFails(updateDoc(other, { doi: 'not-a-doi' }));
  await assertFails(updateDoc(other, { pmid: 'abc' }));
  await assertFails(updateDoc(other, { abstract: 'x'.repeat(20001) }));
  await assertFails(updateDoc(other, { abstractSource: 'guess' }));
  await assertFails(updateDoc(other, { authors: Array.from({ length: 101 }, () => 'A') }));
  await assertFails(updateDoc(other, { manual: Array.from({ length: 11 }, () => 'title') }));
  await assertFails(updateDoc(other, { title: 'T', changedAt: new Date(2020, 0, 1) }));
  await assertFails(updateDoc(other, { title: 'T', addedBy: 'mem2' }));
  await assertFails(updateDoc(other, { title: 'T', file: { pages: 1 } }));
  await assertFails(updateDoc(other, { title: 'T', presented: [] }));
  await assertFails(updateDoc(doc(stranger(), 'papers/e1'), { title: 'T' }));
  await assertFails(updateDoc(doc(as('nobody', 'n@x.org'), 'papers/e1'), { title: 'T' }));
});

test('members add papers as themselves; strangers cannot read or add', async () => {
  const m = as('mem1', 'm@x.org');
  await assertSucceeds(setDoc(doc(m, 'papers/p1'), newPaper('mem1')));
  await assertFails(setDoc(doc(m, 'papers/p2'), newPaper('admin1')));
  await assertFails(setDoc(doc(m, 'papers/p3'), newPaper('mem1', { file: { basis: 'own' } })));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'papers/p4'), newPaper('nobody')));
  await assertSucceeds(getDoc(doc(as('admin1', 'a@x.org'), 'papers/p1')));
  await assertFails(getDoc(doc(as('nobody', 'n@x.org'), 'papers/p1')));
  await assertFails(getDoc(doc(stranger(), 'papers/p1')));
});

test('only the adder or an admin changes a paper\'s file; any member tags it and edits its details', async () => {
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1')));
  await assertSucceeds(updateDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), { tags: ['icu'], file: { pages: 3, basis: 'own' } }));
  await assertSucceeds(updateDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), { title: 'Changed' }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'papers/p1'), { why: 'admin edit' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  await assertSucceeds(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { why: 'any member edits details' }));
  // Any member tags any paper (bulk Add to… in select mode), tags only, up to 20.
  await assertSucceeds(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { tags: ['icu', 'exam'], changedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { tags: ['x'], file: { pages: 9 } }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { file: null }));
  // Old PDF text: no new writes; members read it (for the admin backfill); the adder or an admin deletes it.
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'texts/p1'), { pages: ['page one'] }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'texts/p1'), { pages: ['page one'] }));
  await assertSucceeds(getDoc(doc(as('mem2', 'm2@x.org'), 'texts/p1')));
  await assertSucceeds(getDocs(collection(as('admin1', 'a@x.org'), 'texts')));
  await assertFails(deleteDoc(doc(as('mem2', 'm2@x.org'), 'texts/p1')));
  await assertSucceeds(deleteDoc(doc(as('mem1', 'm@x.org'), 'texts/p1')));
  await assertFails(deleteDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'papers/p1')));
});

test('one note and rating per member, written only by that member', async () => {
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1')));
  const note = (r) => ({ text: 'useful', rating: r, name: 'M', updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/notes/mem1'), note(4)));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/notes/admin1'), note(4)));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/notes/mem1'), note(9)));
  await assertSucceeds(getDocs(collectionGroup(as('admin1', 'a@x.org'), 'notes')));
  await assertFails(getDocs(collectionGroup(as('nobody', 'n@x.org'), 'notes')));
  // Merging duplicates: an admin moves a member's note (its own updatedAt kept) and clears the old one.
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'papers/p1/notes/mem1'), { text: 'moved', rating: 3, name: 'M', updatedAt: Timestamp.fromMillis(Date.now() - HOUR) }));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'papers/p1/notes/mem1'), { text: 'moved', rating: 3, extra: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/notes/mem1'), { text: 'old stamp', rating: 1, updatedAt: Timestamp.fromMillis(0) }));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'papers/p1/notes/mem1')));
});

test('reading lists: private for the maker only; shared lists take any member\'s papers; maker or admin renames and deletes', async () => {
  const list = (uid, visibility = 'shared') => ({ name: 'Part 1 exam', about: '', paperIds: [], createdBy: uid, createdAt: serverTimestamp(), visibility });
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  const m1 = as('mem1', 'm@x.org'), m2 = as('mem2', 'm2@x.org'), ad = as('admin1', 'a@x.org');
  await assertSucceeds(setDoc(doc(m1, 'lists/l1'), list('mem1')));
  await assertSucceeds(setDoc(doc(m1, 'lists/p1'), list('mem1', 'private')));
  await assertFails(setDoc(doc(m1, 'lists/l2'), list('admin1')));
  await assertFails(setDoc(doc(m1, 'lists/l4'), list('mem1', 'secret')));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'lists/l3'), list('nobody')));
  // Private: only the maker (and admins, for merging duplicates) read it, by id or in a query.
  await assertFails(getDoc(doc(m2, 'lists/p1')));
  await assertFails(updateDoc(doc(m2, 'lists/p1'), { paperIds: ['x'] }));
  await assertSucceeds(getDoc(doc(m1, 'lists/p1')));
  await assertSucceeds(getDoc(doc(ad, 'lists/p1')));
  await assertFails(getDocs(collection(m2, 'lists')));
  await assertSucceeds(getDocs(query(collection(m2, 'lists'), where('visibility', '==', 'shared'))));
  await assertSucceeds(getDocs(query(collection(m2, 'lists'), where('createdBy', '==', 'mem2'))));
  await assertFails(getDocs(query(collection(m2, 'lists'), where('createdBy', '==', 'mem1'))));
  await assertSucceeds(getDocs(collection(ad, 'lists')));
  // Shared: any member adds or removes papers, nothing else.
  await assertSucceeds(updateDoc(doc(m2, 'lists/l1'), { paperIds: ['p1', 'p2'] }));
  await assertFails(updateDoc(doc(m2, 'lists/l1'), { name: 'Mine now' }));
  await assertFails(updateDoc(doc(m2, 'lists/l1'), { visibility: 'private' }));
  await assertFails(deleteDoc(doc(m2, 'lists/l1')));
  await assertSucceeds(updateDoc(doc(m1, 'lists/l1'), { paperIds: ['p1'], name: 'Renamed', visibility: 'private' }));
  await assertFails(updateDoc(doc(m1, 'lists/l1'), { createdBy: 'admin1' }));
  await assertSucceeds(updateDoc(doc(ad, 'lists/l1'), { name: 'Admin renamed' }));
  await assertSucceeds(deleteDoc(doc(m1, 'lists/l1')));
  // A list from before visibility existed is shared until an admin stamps it.
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'lists/old'), { name: 'Old', about: '', paperIds: [], createdBy: 'admin1', createdAt: new Date() }));
  await assertSucceeds(getDoc(doc(m2, 'lists/old')));
  await assertSucceeds(updateDoc(doc(m2, 'lists/old'), { paperIds: ['p9'] }));
  await assertFails(updateDoc(doc(m2, 'lists/old'), { visibility: 'shared' }));
  await assertSucceeds(updateDoc(doc(ad, 'lists/old'), { visibility: 'shared' }));
});

test('Starred list: star-<own uid>, private, kind starred; nobody else reads it', async () => {
  const star = (uid, extra = {}) => ({ name: 'Starred', about: '', paperIds: ['p1'], createdBy: uid, createdAt: serverTimestamp(), visibility: 'private', kind: 'starred', ...extra });
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  const m1 = as('mem1', 'm@x.org'), m2 = as('mem2', 'm2@x.org');
  assert.equal((await assertSucceeds(getDoc(doc(m1, 'lists/star-mem1')))).exists(), false);
  await assertSucceeds(setDoc(doc(m1, 'lists/star-mem1'), star('mem1')));
  await assertFails(setDoc(doc(m2, 'lists/star-mem1'), star('mem2')));
  await assertFails(setDoc(doc(m2, 'lists/star-mem2'), star('mem2', { visibility: 'shared' })));
  await assertFails(setDoc(doc(m2, 'lists/other'), star('mem2')));
  await assertFails(getDoc(doc(m2, 'lists/star-mem1')));
  await assertSucceeds(updateDoc(doc(m1, 'lists/star-mem1'), { paperIds: ['p1', 'p2'] }));
  await assertFails(updateDoc(doc(m1, 'lists/star-mem1'), { visibility: 'shared' }));
});

test('prefs: users/<uid> holds the last 20 papers opened, own doc only', async () => {
  const m1 = as('mem1', 'm@x.org');
  await assertSucceeds(setDoc(doc(m1, 'users/mem1'), { recent: ['p1', 'p2'], updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(m1, 'users/mem1')));
  await assertFails(getDoc(doc(as('admin1', 'a@x.org'), 'users/mem1')));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'users/mem1'), { recent: [], updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(m1, 'users/mem1'), { recent: Array.from({ length: 21 }, (_, i) => `p${i}`), updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(m1, 'users/mem1'), { recent: [], starred: ['x'], updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'users/nobody'), { recent: [], updatedAt: serverTimestamp() }));
  // Saved searches sit beside Recent; either may be written alone (merge), 20 at most.
  await assertSucceeds(setDoc(doc(m1, 'users/mem1'), { searches: ['tag:airway', 'author:lee'], updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(m1, 'users/mem1'), { recent: ['p3'], updatedAt: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(m1, 'users/mem1'), { searches: Array.from({ length: 21 }, (_, i) => `q${i}`), updatedAt: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(m1, 'users/mem1'), { searches: 'tag:x', updatedAt: serverTimestamp() }, { merge: true }));
});

test('votes and the rota are gone: every path is denied', async () => {
  await setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1'));
  const m = as('mem1', 'm@x.org'); const ad = as('admin1', 'a@x.org');
  await assertFails(setDoc(doc(m, 'papers/p1/votes/mem1'), { at: serverTimestamp() }));
  await assertFails(getDocs(collectionGroup(ad, 'votes')));
  await assertFails(setDoc(doc(ad, 'rota/main'), { order: [], next: 0, updatedBy: 'admin1', updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(m, 'rota/main')));
});

const session = (uid, extra = {}) => ({ date: future(), paperId: 'p1', paperTitle: 'T', presenterUid: 'mem1', presenterName: 'M',
  summary: '', slides: '', createdBy: uid, createdAt: serverTimestamp(), ...extra });
const addMember = (uid) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members', uid), { email: `${uid}@x.org`, role: 'member', inviteId: 'seed' }));

test('sessions: any member plans one as themselves; creator, presenter, coordinator and admins edit; creator and admins delete', async () => {
  await addMember('mem2'); await addMember('mem3');
  const m1 = as('mem1', 'm@x.org'); const m2 = as('mem2', 'mem2@x.org'); const m3 = as('mem3', 'mem3@x.org');
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'sessions/sx'), session('nobody')));
  await assertFails(setDoc(doc(m2, 'sessions/sx'), session('mem1')));
  await assertSucceeds(setDoc(doc(m2, 'sessions/s1'), session('mem2', { coordinatorUid: 'mem3', coordinatorName: 'M3', teamsUrl: 'https://teams.example/x' })));
  await assertFails(setDoc(doc(m2, 'sessions/s2'), session('mem2', { teamsUrl: 'javascript:alert(1)' })));
  await assertSucceeds(getDoc(doc(m1, 'sessions/s1')));
  await assertFails(getDoc(doc(stranger(), 'sessions/s1')));
  // Creator, presenter and the member coordinator edit the plan and the summary.
  await assertSucceeds(updateDoc(doc(m2, 'sessions/s1'), { date: future(48 * HOUR), paperTitle: 'T2', presenterUid: 'mem1' }));
  await assertSucceeds(updateDoc(doc(m1, 'sessions/s1'), { summary: 'Key points', slides: 'https://example.org/s' }));
  await assertSucceeds(updateDoc(doc(m3, 'sessions/s1'), { coordinatorName: 'M3 renamed' }));
  await assertFails(updateDoc(doc(m1, 'sessions/s1'), { slides: 'javascript:alert(1)' }));
  await assertSucceeds(updateDoc(doc(m1, 'sessions/s1'), { slidesFile: { name: 'Talk.pptx', size: 1200, kind: 'pptx', pdf: true }, slides: '' }));
  await assertSucceeds(updateDoc(doc(m1, 'sessions/s1'), { slidesFile: {} }));
  await assertFails(updateDoc(doc(m1, 'sessions/s1'), { slidesFile: { name: 'x.exe', size: 1, kind: 'exe', pdf: false } }));
  await assertFails(updateDoc(doc(m1, 'sessions/s1'), { slidesFile: { name: 'x.pdf', size: 1, kind: 'pdf', pdf: true, url: 'https://x' } }));
  // Locking and the form override stay with admins.
  await assertFails(updateDoc(doc(m2, 'sessions/s1'), { locked: true }));
  await assertFails(updateDoc(doc(m2, 'sessions/s1'), { template: [] }));
  // Another member cannot edit or delete someone else's session.
  await addMember('mem4');
  const m4 = as('mem4', 'mem4@x.org');
  await assertFails(updateDoc(doc(m4, 'sessions/s1'), { presenterName: 'Hijack' }));
  await assertFails(updateDoc(doc(m4, 'sessions/s1'), { summary: 'not mine' }));
  await assertFails(deleteDoc(doc(m4, 'sessions/s1')));
  await assertFails(deleteDoc(doc(m1, 'sessions/s1')));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'sessions/s1'), { presenterUid: 'mem4', presenterName: 'M4' }));
  await assertSucceeds(deleteDoc(doc(m2, 'sessions/s1')));
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'sessions/s3'), session('admin1')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'sessions/s3')));
});

test('a locked session is closed to its creator; a member keeps a paper\'s presented summary, nothing else', async () => {
  await setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1'));
  await addMember('mem2');
  const m2 = as('mem2', 'mem2@x.org');
  const b = writeBatch(m2);
  b.set(doc(m2, 'sessions/s1'), session('mem2'));
  b.update(doc(m2, 'papers/p1'), { presented: [{ sid: 's1', date: future() }] });
  await assertSucceeds(b.commit());
  await assertFails(updateDoc(doc(m2, 'papers/p1'), { addedBy: 'mem2' }));
  await assertFails(updateDoc(doc(m2, 'papers/p1'), { presented: 'x' }));
  await assertFails(updateDoc(doc(as('nobody', 'n@x.org'), 'papers/p1'), { presented: [] }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'sessions/s1'), { locked: true }));
  await assertFails(updateDoc(doc(m2, 'sessions/s1'), { summary: 'late' }));
});

// --- S4: group invites and removal flags ---
const seedGroup = (id = 'grp', expiresAt = future()) => env.withSecurityRulesDisabled((ctx) =>
  setDoc(doc(ctx.firestore(), 'invites', id), { createdBy: 'admin1', createdAt: new Date(), expiresAt, used: false, group: true, note: 'residents' }));
const joinGroup = (db, uid, email, token) =>
  setDoc(doc(db, 'members', uid), { email, name: 'New', role: 'member', inviteId: token, joinedAt: serverTimestamp() });

test('a group invite admits many people and is never consumed', async () => {
  await seedGroup();
  await assertSucceeds(joinGroup(as('g1', 'g1@x.org'), 'g1', 'g1@x.org', 'grp'));
  await assertSucceeds(joinGroup(as('g2', 'g2@x.org'), 'g2', 'g2@x.org', 'grp'));
  let used;
  await env.withSecurityRulesDisabled(async (ctx) => { used = (await getDoc(doc(ctx.firestore(), 'invites/grp'))).data().used; });
  assert.equal(used, false);
});

test('a group invite cannot be consumed as a single-use invite', async () => {
  await seedGroup();
  await assertFails(redeem(as('g3', 'g3@x.org'), 'g3', 'g3@x.org', 'grp'));
  await assertFails(updateDoc(doc(as('g3', 'g3@x.org'), 'invites/grp'), { used: true, usedBy: 'g3', usedAt: serverTimestamp() }));
});

test('expired, revoked or forged group invites admit nobody', async () => {
  await seedGroup('grpold', past());
  await assertFails(joinGroup(as('g4', 'g4@x.org'), 'g4', 'g4@x.org', 'grpold'));
  await assertFails(joinGroup(as('g5', 'g5@x.org'), 'g5', 'g5@x.org', 'revoked'));
  await seedGroup();
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'invites/grp')));
  await assertFails(joinGroup(as('g6', 'g6@x.org'), 'g6', 'g6@x.org', 'grp'));
  // a plain single-use invite is not a group invite just because someone skips the batch
  await assertFails(joinGroup(as('g7', 'g7@x.org'), 'g7', 'g7@x.org', 'good'));
});

test('group join cannot make an admin or use another person\'s email', async () => {
  await seedGroup();
  await assertFails(setDoc(doc(as('g8', 'g8@x.org'), 'members/g8'), { email: 'g8@x.org', name: 'x', role: 'admin', inviteId: 'grp', joinedAt: serverTimestamp() }));
  await assertFails(joinGroup(as('g9', 'g9@x.org'), 'g9', 'other@x.org', 'grp'));
  await assertFails(joinGroup(stranger(), 'g10', 'g10@x.org', 'grp'));
});

test('only admins create group invites, within 30 days', async () => {
  const g = (uid, ms) => ({ createdBy: uid, createdAt: serverTimestamp(), expiresAt: future(ms), used: false, group: true, note: 'n' });
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'invites/g-ok'), g('admin1', 7 * 24 * HOUR)));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'invites/g-no'), g('mem1', 7 * 24 * HOUR)));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'invites/g-long'), g('admin1', 60 * 24 * HOUR)));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'invites/g-str'), { ...g('admin1', HOUR), group: 'yes' }));
});

const flag = (uid, extra = {}) => ({ paperId: 'p1', paperTitle: 'A trial', what: 'pdf', reason: 'Copyright', by: uid, byName: 'M', at: serverTimestamp(), ...extra });

test('any member flags a paper as themselves; only admins read or dismiss flags', async () => {
  await setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1'));
  const m = as('mem1', 'm@x.org');
  await assertSucceeds(setDoc(doc(m, 'flags/f1'), flag('mem1')));
  await assertSucceeds(setDoc(doc(m, 'flags/f2'), flag('mem1', { what: 'paper' })));
  await assertFails(setDoc(doc(m, 'flags/f3'), flag('admin1')));
  await assertFails(setDoc(doc(m, 'flags/f4'), flag('mem1', { what: 'everything' })));
  await assertFails(setDoc(doc(m, 'flags/f5'), flag('mem1', { reason: '' })));
  await assertFails(setDoc(doc(m, 'flags/f6'), flag('mem1', { reason: 'x'.repeat(501) })));
  await assertFails(setDoc(doc(m, 'flags/f7'), flag('mem1', { paperId: 'nope' })));
  await assertFails(setDoc(doc(m, 'flags/f8'), flag('mem1', { extra: 1 })));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'flags/f9'), flag('nobody')));
  await assertFails(getDoc(doc(m, 'flags/f1')));
  await assertFails(getDocs(collection(m, 'flags')));
  await assertFails(deleteDoc(doc(m, 'flags/f1')));
  await assertSucceeds(getDocs(collection(as('admin1', 'a@x.org'), 'flags')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'flags/f1')));
});

test('discussion: presenter, member coordinator and admins fill it; only admins set template and lock', async () => {
  const mk = (id) => env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'sessions', id), {
    date: future(), paperId: 'p1', paperTitle: 'T', presenterUid: 'mem1', presenterName: 'M', summary: '', slides: '',
    createdBy: 'admin1', createdAt: new Date() }));
  await mk('s1');
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem3'), { email: 'm3@x.org', role: 'member', inviteId: 'seed' }));
  const disc = { fields: [{ id: 'a', label: 'A', type: 'long' }], answers: { a: 'x' } };
  const ref = (uid, email) => doc(as(uid, email), 'sessions/s1');
  await assertSucceeds(updateDoc(ref('mem1', 'm@x.org'), { discussion: disc }));
  // Not the presenter, not yet the coordinator.
  await assertFails(updateDoc(ref('mem2', 'm2@x.org'), { discussion: disc }));
  // Presenter can't change the template or lock.
  await assertFails(updateDoc(ref('mem1', 'm@x.org'), { template: [] }));
  await assertFails(updateDoc(ref('mem1', 'm@x.org'), { locked: true }));
  await assertSucceeds(updateDoc(ref('admin1', 'a@x.org'), { coordinatorUid: 'mem2', coordinatorName: 'M2', teamsUrl: 'https://teams.example/x', time: '17:30' }));
  await assertFails(updateDoc(ref('admin1', 'a@x.org'), { teamsUrl: 'javascript:alert(1)' }));
  await assertFails(updateDoc(ref('admin1', 'a@x.org'), { time: '25:00' }));
  // A member coordinator edits the discussion too; a typed-name coordinator (no uid) gives no one rights.
  await assertSucceeds(updateDoc(ref('mem2', 'm2@x.org'), { discussion: { ...disc, answers: { a: 'y' } } }));
  await assertFails(updateDoc(ref('mem3', 'm3@x.org'), { discussion: disc }));
  await assertFails(updateDoc(ref('mem2', 'm2@x.org'), { discussion: { fields: [], answers: {}, extra: 1 } }));
  // Locked: admins only.
  await assertSucceeds(updateDoc(ref('admin1', 'a@x.org'), { locked: true }));
  await assertFails(updateDoc(ref('mem1', 'm@x.org'), { discussion: disc }));
  await assertFails(updateDoc(ref('mem2', 'm2@x.org'), { discussion: disc }));
  await assertSucceeds(updateDoc(ref('admin1', 'a@x.org'), { discussion: disc }));
});

test('points: one per member per session, own only, closed when locked', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'sessions/s1'), {
    date: future(), paperId: 'p1', paperTitle: 'T', presenterUid: 'mem1', presenterName: 'M', summary: '', slides: '',
    createdBy: 'admin1', createdAt: new Date() }));
  const pt = (uid, email, id = uid) => doc(as(uid, email), 'sessions/s1/points', id);
  const body = { text: 'Use less opioid', name: 'M', updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(pt('mem1', 'm@x.org'), body));
  await assertSucceeds(setDoc(pt('mem1', 'm@x.org'), { ...body, text: 'Edited' }));
  await assertFails(setDoc(pt('mem1', 'm@x.org', 'other'), body));
  await assertFails(setDoc(pt('mem1', 'm@x.org'), { ...body, text: '' }));
  await assertFails(setDoc(pt('nobody', 'n@x.org'), body));
  await assertSucceeds(getDocs(collectionGroup(as('admin1', 'a@x.org'), 'points')));
  await assertFails(getDocs(collection(stranger(), 'sessions/s1/points')));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'sessions/s1'), { locked: true }));
  await assertFails(setDoc(pt('mem1', 'm@x.org'), { ...body, text: 'Late' }));
});

test('config: members read the Teams link; only admins write it', async () => {
  const cfg = { teamsUrl: 'https://teams.example/m', pointPrompt: 'Your take-home point', time: '16:00', updatedBy: 'admin1', updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'config/club'), cfg));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'config/club'), { ...cfg, updatedBy: 'mem1' }));
  await assertSucceeds(getDoc(doc(as('mem1', 'm@x.org'), 'config/club')));
  await assertFails(getDoc(doc(stranger(), 'config/club')));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'config/club'), { ...cfg, teamsUrl: 'http://x' }));
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'config/discussion'),
    { fields: [{ id: 'a', label: 'A', type: 'long' }], updatedBy: 'admin1', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'config/discussion'), { fields: [], updatedBy: 'mem1', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('admin1', 'a@x.org'), 'config/other'), { updatedBy: 'admin1', updatedAt: serverTimestamp() }));
});

test('decks: any member adds one as its maker; the maker and admins edit or delete it; strangers read nothing', async () => {
  const m = as('mem1', 'm@x.org');
  const deck = { title: 'Difficult airway', tags: ['airway'], by: 'M', about: '', date: null, slidesFile: {}, createdBy: 'mem1', createdAt: serverTimestamp(), changedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(m, 'decks/d1'), deck));
  await assertFails(setDoc(doc(m, 'decks/d2'), { ...deck, createdBy: 'admin1' }));
  await assertFails(setDoc(doc(m, 'decks/d3'), { ...deck, title: '' }));
  await assertFails(setDoc(doc(m, 'decks/d4'), { ...deck, extra: 1 }));
  await assertSucceeds(updateDoc(doc(m, 'decks/d1'), { slidesFile: { name: 'a.pdf', size: 10, kind: 'pdf', pdf: true }, changedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(m, 'decks/d1'), { createdBy: 'mem2' }));
  await assertFails(updateDoc(doc(m, 'decks/d1'), { slidesFile: { name: 'a.pdf', kind: 'docx' } }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'o@x.org', name: 'O', role: 'member', inviteId: 'seed' }));
  const o = as('mem2', 'o@x.org');
  await assertSucceeds(getDoc(doc(o, 'decks/d1')));
  await assertFails(updateDoc(doc(o, 'decks/d1'), { title: 'Mine now' }));
  await assertFails(deleteDoc(doc(o, 'decks/d1')));
  await assertFails(getDoc(doc(stranger(), 'decks/d1')));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'decks/d1'), { title: 'Airway', changedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(m, 'decks/d1')));
});
