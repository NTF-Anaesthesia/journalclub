import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

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
