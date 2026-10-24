import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';

// Long jobs on a phone: Fill missing details and Rebuild keep their place on the device and carry on after a reload,
// a dropped connection or a failed call.
test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const arr = (xs) => ({ arrayValue: { values: xs.map(s) } });
const at = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const T0 = Date.UTC(2026, 0, 1);
const N = 20;

async function setup(page, email, count = N) {
  const wk = await workerApi(page, PROJECT);
  await page.addInitScript(() => { window.__jcRetryDelays = [0, 0, 0]; });
  await page.goto(`/?emulator=${PROJECT}#/library`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  expect((await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s('Admin'), role: s('admin'), inviteId: s('seed') } } })).ok()).toBeTruthy();
  for (let i = 1; i <= count; i++) {
    expect((await page.request.patch(`${DOCS}/papers/lj${String(i).padStart(2, '0')}`, { headers: owner, data: { fields: {
      title: s(`Long job paper ${i}`), doi: s(''), pmid: s(''), abstract: s(''), authors: arr(['Ann Author']), journal: s('Anaesthesia'), tags: arr([]),
      file: { mapValue: { fields: { pages: { integerValue: '1' } } } }, addedBy: s(uid), addedAt: at(T0 + i * 1000), changedAt: at(T0 + i * 1000) } } })).ok()).toBeTruthy();
  }
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();
  return { ...wk, uid };
}

async function startFill(page) {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: `All ${N}` }).click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.locator('#mfill').click();
}

test('Fill 20 papers, reload mid-run, Resume finishes only the rest and the counts add up', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page, 'lj.fill@example.org');
  const seen = [];
  await page.route('**/api/enrich/**', async (route) => {
    seen.push(route.request().url().split('/').pop());
    await new Promise((r) => setTimeout(r, 400));
    await route.fallback();
  });
  await startFill(page);
  const sheet = page.getByRole('dialog', { name: 'Filling papers' });
  await expect(sheet.getByRole('heading', { name: /^Filling/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':job')).map((k) => JSON.parse(localStorage[k]).done)[0] || 0)).toBeGreaterThanOrEqual(3);
  await page.unroute('**/api/enrich/**');
  seen.length = 0;
  await page.route('**/api/enrich/**', (route) => { seen.push(route.request().url().split('/').pop()); return route.fallback(); });
  await page.reload();
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':job')).map((k) => JSON.parse(localStorage[k]))[0]);
  expect(saved.ids.length).toBeLessThan(N);
  expect(saved.done + saved.ids.length).toBeGreaterThanOrEqual(N); // papers in flight stay on the list
  const bar = page.locator('#resumebar');
  await expect(bar).toContainText(`Fill missing details paused: ${saved.ids.length} of ${N} left`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await bar.getByRole('button', { name: 'Resume' }).click();
  const prog = page.getByRole('dialog', { name: 'Filling papers' });
  await expect(prog.getByRole('heading', { name: `Done: ${N} papers` })).toBeVisible({ timeout: 30000 });
  await expect(prog.locator('li', { hasText: 'No PDF text' })).toContainText(String(N));
  // Only the unfinished ones, never a finished paper (a request from before the reload may be seen once more).
  expect([...new Set(seen)].sort()).toEqual([...saved.ids].sort());
  await expect(bar).toBeHidden();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':job')))).toEqual([]);
});

test('Fill: no connection pauses the job with its place saved, and it carries on from Resume', async ({ page }) => {
  test.setTimeout(60000);
  await setup(page, 'lj.net@example.org');
  await page.route('**/api/enrich/**', (route) => route.abort());
  await startFill(page);
  const sheet = page.getByRole('dialog', { name: 'Filling papers' });
  await expect(sheet.getByRole('heading', { name: `Paused: ${N} papers` })).toBeVisible({ timeout: 20000 });
  await expect(sheet).toContainText('Paused: no connection');
  await sheet.getByRole('button', { name: 'Hide' }).click();
  await expect(page.locator('#resumebar')).toContainText(`paused: ${N} of ${N} left`); // nothing was used up
  await page.unroute('**/api/enrich/**');
  await page.locator('#resumebar').getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('dialog', { name: 'Filling papers' }).getByRole('heading', { name: `Done: ${N} papers` })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#resumebar')).toBeHidden();
});

test('Rebuild: a forced 500 keeps the cursor and Resume carries on from it; notes only, no texts phase', async ({ page }) => {
  test.setTimeout(60000);
  await setup(page, 'lj.rebuild@example.org', 30);
  const bodies = [];
  let fail = false, first = true;
  await page.route('**/api/backfill', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    bodies.push(body);
    if (fail) return route.fulfill({ status: 500, json: { error: 'boom' } });
    if (first) { first = false; fail = true; } // the first batch goes through, then every call fails
    return route.fallback();
  });
  await page.goto(`/?emulator=${PROJECT}#/reindex`);
  await expect(page.getByText("Re-indexes members' shared notes. For PDF text use Reindex PDFs in select mode.")).toBeVisible();
  await page.getByRole('button', { name: 'Rebuild' }).click();
  await expect(page.locator('#rmsg')).toContainText('Stopped: HTTP 500');
  expect(bodies[0]).toEqual({});
  const cursor = bodies[1];
  expect(cursor.phase).toBe('notes');
  expect(cursor.pageToken).toBeTruthy();
  await page.reload();
  await expect(page.locator('#rsaved')).toContainText("Rebuild paused: 0 papers' notes done so far");
  fail = false; bodies.length = 0;
  await page.locator('#rsaved').getByRole('button', { name: 'Resume' }).click();
  await expect(page.locator('#rmsg')).toContainText('Done:');
  expect(bodies[0]).toEqual(cursor); // carried on from the saved cursor, not from paper 1
  await expect(page.locator('#rsaved')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
