import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';
import { indexPages } from '../worker/search.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const arr = (xs) => ({ arrayValue: { values: xs.map(s) } });
const at = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const T0 = Date.UTC(2026, 0, 1);
const FILE = { mapValue: { fields: { pages: { integerValue: '1' } } } };
const P453 = 'ANAESTHESIA TUTORIAL OF THE WEEK 453 20th May 2013 The Shoulder Block Dr A Author. Summary The brachial plexus supplies the arm.';
const P242 = 'ANAESTHESIA TUTORIAL OF THE WEEK 242 9th January 2012 SEDATION IN THE ICU Dr Jane Roe.';

async function signIn(page, email, role = 'member') {
  await page.goto(`/?emulator=${PROJECT}#/library`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const r = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s(email.split('@')[0]), role: s(role), inviteId: s('seed') } } });
  expect(r.ok()).toBeTruthy();
  return uid;
}
const seed = (page, id, fields) => page.request.patch(`${DOCS}/papers/${id}`, { headers: owner, data: { fields: {
  doi: s(''), pmid: s(''), abstract: s('abs'), authors: arr([]), journal: s(''), tags: arr([]), file: FILE, ...fields } } })
  .then((r) => expect(r.ok()).toBeTruthy());
const doc = (page, id) => page.request.get(`${DOCS}/papers/${id}`, { headers: owner }).then((r) => r.json());
const open = async (page, hash = 'library') => { await page.goto(`/?emulator=${PROJECT}#/${hash}`); await page.reload(); };
test('admin Tidy ATOTW: preview first, nothing written until Apply; hand edits stay; number is searchable', async ({ page }) => {
  test.setTimeout(90000);
  const w = await workerApi(page, PROJECT);
  const uid = await signIn(page, 'admin.tidy@example.org', 'admin');
  await seed(page, 'a1', { title: s('ATOTW 453 the_shoulder_block'), addedBy: s(uid), addedAt: at(T0 + 1000) });
  await seed(page, 'a2', { title: s('ATOTW 242 sedation in the icu'), year: { integerValue: '1999' }, manual: arr(['year']), addedBy: s(uid), addedAt: at(T0 + 2000) });
  await seed(page, 'o1', { title: s('Unrelated trial of propofol'), addedBy: s(uid), addedAt: at(T0 + 3000) });
  await indexPages(w.db, 'a1', [P453]);
  await indexPages(w.db, 'a2', [P242]);
  await open(page);

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: /^All 3$/ }).click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Tidy ATOTW' }).click();
  const tidy = page.getByRole('dialog', { name: 'Tidy ATOTW' });
  await expect(tidy.getByText(/2 to change, 0 already tidy, 0 unsure/)).toBeVisible({ timeout: 20000 });
  await expect(tidy.getByText('ATOTW 453 the_shoulder_block → The shoulder block')).toBeVisible();
  await expect(tidy.getByText('Year: 2013')).toBeVisible();
  await expect(tidy.getByText('Year: 1999')).toHaveCount(0);
  await expect(tidy).not.toContainText('propofol');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Cancel writes nothing.
  await tidy.getByRole('button', { name: 'Cancel' }).click();
  expect((await doc(page, 'a1')).fields.title.stringValue).toBe('ATOTW 453 the_shoulder_block');

  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Tidy ATOTW' }).click();
  await page.getByRole('button', { name: 'Apply to 2' }).click();
  await expect(page.getByText(/Tidied 2; 0 unchanged, 0 unsure/)).toBeVisible({ timeout: 20000 });

  const a1 = (await doc(page, 'a1')).fields, a2 = (await doc(page, 'a2')).fields;
  expect(a1.title.stringValue).toBe('The shoulder block');
  expect(a1.journal.stringValue).toBe('Anaesthesia Tutorial of the Week');
  expect(a1.year.integerValue).toBe('2013');
  expect(a1.atotw.integerValue).toBe('453');
  expect(a1.manual.arrayValue.values.map((v) => v.stringValue).sort()).toEqual(['journal', 'title', 'year']);
  expect(a1.tags.arrayValue.values || []).toHaveLength(0); // no new tags
  expect(a2.title.stringValue).toBe('Sedation in the ICU');
  expect(a2.year.integerValue).toBe('1999'); // typed by hand: stays
  expect((await doc(page, 'o1')).fields.title.stringValue).toBe('Unrelated trial of propofol');

  // The number shows in the meta line and finds the paper.
  await open(page, 'paper/a1');
  await expect(page.getByText('Anaesthesia Tutorial of the Week · 2013 · No. 453')).toBeVisible();
  await open(page);
  await page.getByLabel('Search the library').fill('453');
  await expect(page.locator('#res li', { hasText: 'The shoulder block' })).toBeVisible();
  await expect(page.locator('#res li')).toHaveCount(1);

  // Running it again finds nothing to change.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'All 1' }).click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Tidy ATOTW' }).click();
  await expect(page.getByRole('dialog', { name: 'Tidy ATOTW' }).getByText(/0 to change, 1 already tidy/)).toBeVisible({ timeout: 20000 });
});
