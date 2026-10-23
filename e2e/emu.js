// Shared test setup: each Playwright worker gets its own emulator project, and every test starts from an empty one
// (Firestore documents and Auth accounts cleared), so specs never see another test's data and can run in parallel.
import { randomBytes } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

export { expect };
export const PROJECT = `demo-${randomBytes(5).toString('hex')}`;
export const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
export const BASE = `projects/${PROJECT}/databases/(default)/documents`;

export async function resetEmulators(request) {
  const f = await request.delete(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`);
  const a = await request.delete(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`);
  expect(f.ok() && a.ok()).toBeTruthy();
}

export const test = base.extend({
  resetEmulators: [async ({ request }, use) => { await resetEmulators(request); await use(); }, { auto: true }],
});
