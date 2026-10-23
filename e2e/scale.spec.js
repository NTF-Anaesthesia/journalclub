import { test, expect } from '@playwright/test';
import { workerApi } from './worker-api.js';
import { indexPages } from '../worker/search.js';

test.use({ viewport: { width: 390, height: 844 } });

const PROJECT = 'demo-scale';
const DOCS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const BASE = `projects/${PROJECT}/databases/(default)/documents`;
const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const at = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const T0 = Date.UTC(2026, 0, 1);

async function signIn(page, email) {
  await page.goto(`/?emulator=${PROJECT}`);
  return page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
}
async function makeMember(page, uid, email) {
  const r = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s('Res Scale'), role: s('member'), inviteId: s('seed') } } });
  expect(r.ok()).toBeTruthy();
}

const paperFields = (i, uid, extra = {}) => ({
  title: s(`Seeded trial ${String(i).padStart(4, '0')} of airway devices`), doi: s(''), pmid: s(''),
  authors: { arrayValue: { values: [s(`Author ${i}`), s('B Second')] } }, journal: s('Anaesthesia'),
  year: { integerValue: String(2000 + (i % 25)) }, tags: { arrayValue: { values: [s(i % 2 ? 'airway' : 'obstetric')] } },
  addedBy: s(uid), addedAt: at(T0 + i * 1000), changedAt: at(T0 + i * 1000), ...extra,
});

// 1000 papers (fixtures, no real PDFs) in two commits; paper 0500 has a 9-page PDF indexed in D1.
async function seed(page, uid, db) {
  for (let from = 0; from < 1000; from += 500) {
    const writes = Array.from({ length: 500 }, (_, k) => {
      const i = from + k;
      const extra = i === 500 ? { file: { mapValue: { fields: { pages: { integerValue: '9' } } } } } : {};
      return { update: { name: `${BASE}/papers/s${String(i).padStart(4, '0')}`, fields: paperFields(i, uid, extra) } };
    });
    const r = await page.request.post(`${DOCS}:commit`, { headers: owner, data: { writes } });
    expect(r.ok()).toBeTruthy();
  }
  const pages = Array.from({ length: 9 }, (_, k) => `Page ${k + 1} of methods and results`);
  pages[6] = 'Videolaryngoscopy with the zygomatic approach halved failed intubations in this cohort';
  await indexPages(db, 's0500', pages);
  // An old texts/ doc the client must no longer read.
  await page.request.patch(`${DOCS}/texts/s0001`, { headers: owner, data: { fields: {
    pages: { arrayValue: { values: [s('Quokkaword only in the old texts collection')] } } } } });
}

const stats = (page) => page.evaluate(() => window.__jcCatalogue);

test('1000 papers: first page under 2 s, paged list, PDF word search from the Worker, repeat open reads only changes', async ({ page }) => {
  test.setTimeout(90000);
  // Its own emulator project, so other specs' papers (and their parallel runs) don't change the counts.
  const { db, calls } = await workerApi(page, PROJECT);
  expect((await page.request.delete(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`)).ok()).toBeTruthy();
  // Papers first, membership last, so the app can't load (and cache) a half-seeded library.
  const uid = await signIn(page, 'scale@example.org');
  await seed(page, uid, db);
  await makeMember(page, uid, 'scale@example.org');

  // Cold open: no sync stamp, so a full read (the newest 50 shown first).
  await page.evaluate(() => localStorage.removeItem('jc.catalogueSync'));
  const t0 = Date.now();
  await page.reload();
  await expect(page.locator('#res li')).toHaveCount(50);
  const firstPage = Date.now() - t0;
  console.log(`first page of 1000 papers: ${firstPage} ms`);
  expect(firstPage).toBeLessThan(2000);
  await expect(page.getByText('1000 papers, newest first')).toBeVisible();
  await expect(page.locator('#res li').first()).toContainText('Seeded trial 0999');
  expect(await stats(page)).toEqual({ mode: 'full', fetched: 1000, size: 1000 });

  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('#res li')).toHaveCount(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // A word inside a PDF: the Worker returns the paper, its page and a snippet.
  await page.getByLabel('Search the library').fill('zygomatic');
  const hit = page.locator('#res li');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText('Seeded trial 0500');
  await expect(hit.locator('.hit')).toHaveText('p. 7');
  await expect(hit.locator('.snippet mark')).toHaveText('zygomatic');
  await expect(hit.getByRole('link')).toHaveAttribute('href', '#/paper/s0500/7');
  expect(calls).toContain('GET /api/search');
  // Metadata still searches on the phone; the old texts/ collection is not read.
  await page.getByLabel('Search the library').fill('trial 0042');
  await expect(page.locator('#res li').first()).toContainText('Seeded trial 0042');
  await page.getByLabel('Search the library').fill('quokkaword');
  await expect(page.getByText('Nothing found.')).toBeVisible();
  await page.getByLabel('Search the library').fill('');

  // Repeat open: the catalogue comes from the cache plus only the papers changed since.
  await page.reload();
  await expect(page.locator('#res li')).toHaveCount(50);
  expect(await stats(page)).toEqual({ mode: 'delta', fetched: 0, size: 1000 });

  const r = await page.request.patch(`${DOCS}/papers/s0003?updateMask.fieldPaths=title&updateMask.fieldPaths=changedAt`, {
    headers: owner, data: { fields: { title: s('Renamed trial three'), changedAt: at(Date.now()) } } });
  expect(r.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#res li')).toHaveCount(50);
  expect(await stats(page)).toEqual({ mode: 'delta', fetched: 1, size: 1000 });
  await page.getByLabel('Search the library').fill('renamed');
  await expect(page.locator('#res li').first()).toContainText('Renamed trial three');

  // A paper removed elsewhere: the count no longer matches, so the catalogue is read again in full.
  expect((await page.request.delete(`${DOCS}/papers/s0004`, { headers: owner })).ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#res li')).toHaveCount(50);
  expect(await stats(page)).toEqual({ mode: 'full', fetched: 999, size: 999 });
});
