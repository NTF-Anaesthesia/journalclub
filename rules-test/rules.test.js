import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, collectionGroup, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

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

test('only the adder or an admin edits a paper, and only tags, why and file', async () => {
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1')));
  await assertSucceeds(updateDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), { tags: ['icu'], file: { pages: 3, basis: 'own' } }));
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), { title: 'Changed' }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'papers/p1'), { why: 'admin edit' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'papers/p1'), { why: 'not mine' }));
  await assertFails(setDoc(doc(as('mem2', 'm2@x.org'), 'texts/p1'), { pages: ['x'] }));
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'texts/p1'), { pages: ['page one'] }));
  await assertSucceeds(getDoc(doc(as('mem2', 'm2@x.org'), 'texts/p1')));
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
});

test('reading lists: members create; only the maker or an admin edits', async () => {
  const list = (uid) => ({ name: 'Part 1 exam', about: '', paperIds: [], createdBy: uid, createdAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'lists/l1'), list('mem1')));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'lists/l2'), list('admin1')));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'lists/l3'), list('nobody')));
  await assertSucceeds(updateDoc(doc(as('mem1', 'm@x.org'), 'lists/l1'), { paperIds: ['p1'] }));
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'lists/l1'), { createdBy: 'admin1' }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'lists/l1'), { name: 'Renamed' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'lists/l1'), { paperIds: [] }));
  await assertFails(deleteDoc(doc(as('mem2', 'm2@x.org'), 'lists/l1')));
  await assertSucceeds(deleteDoc(doc(as('mem1', 'm@x.org'), 'lists/l1')));
});

test('a member votes once per paper, only as themselves, and can undo it', async () => {
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1'), newPaper('mem1')));
  const vote = () => ({ at: serverTimestamp() });
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/votes/mem1'), vote()));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/votes/mem1'), vote()));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/votes/admin1'), vote()));
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'papers/nope/votes/mem1'), vote()));
  await assertFails(setDoc(doc(as('nobody', 'n@x.org'), 'papers/p1/votes/nobody'), vote()));
  await assertSucceeds(getDocs(collectionGroup(as('admin1', 'a@x.org'), 'votes')));
  await assertFails(getDocs(collectionGroup(stranger(), 'votes')));
  await assertFails(deleteDoc(doc(as('admin1', 'a@x.org'), 'papers/p1/votes/mem1')));
  await assertSucceeds(deleteDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/votes/mem1')));
  await assertSucceeds(setDoc(doc(as('mem1', 'm@x.org'), 'papers/p1/votes/mem1'), vote()));
});

test('only admins edit the rota; members read it', async () => {
  const rota = (uid) => ({ order: [{ uid: 'mem1', name: 'M' }], next: 0, updatedBy: uid, updatedAt: serverTimestamp() });
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'rota/main'), rota('mem1')));
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'rota/main'), rota('admin1')));
  await assertSucceeds(getDoc(doc(as('mem1', 'm@x.org'), 'rota/main')));
  await assertFails(getDoc(doc(as('nobody', 'n@x.org'), 'rota/main')));
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'rota/main'), { next: 1 }));
  await assertFails(deleteDoc(doc(as('mem1', 'm@x.org'), 'rota/main')));
});

test('sessions: admins plan; the presenter edits only summary and slides', async () => {
  const session = (uid) => ({ date: future(), paperId: 'p1', paperTitle: 'T', presenterUid: 'mem1', presenterName: 'M',
    summary: '', slides: '', createdBy: uid, createdAt: serverTimestamp() });
  await assertFails(setDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1'), session('mem1')));
  await assertSucceeds(setDoc(doc(as('admin1', 'a@x.org'), 'sessions/s1'), session('admin1')));
  await assertSucceeds(getDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1')));
  await assertFails(getDoc(doc(stranger(), 'sessions/s1')));
  await assertSucceeds(updateDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1'), { summary: 'Key points', slides: 'https://example.org/s' }));
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1'), { slides: 'javascript:alert(1)' }));
  await assertFails(updateDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1'), { presenterUid: 'admin1' }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'members/mem2'), { email: 'm2@x.org', role: 'member', inviteId: 'seed' }));
  await assertFails(updateDoc(doc(as('mem2', 'm2@x.org'), 'sessions/s1'), { summary: 'not mine' }));
  await assertSucceeds(updateDoc(doc(as('admin1', 'a@x.org'), 'sessions/s1'), { presenterUid: 'mem2', presenterName: 'M2' }));
  await assertFails(deleteDoc(doc(as('mem1', 'm@x.org'), 'sessions/s1')));
  await assertSucceeds(deleteDoc(doc(as('admin1', 'a@x.org'), 'sessions/s1')));
});
