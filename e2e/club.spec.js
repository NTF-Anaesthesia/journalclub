import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const REST = 'http://127.0.0.1:8080/v1/projects/demo-jc/databases/(default)/documents';
const owner = { Authorization: 'Bearer owner' };

async function signInAs(browser, email, name, role) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/?emulator');
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(`${REST}/members/${uid}`, { headers: owner, data: { fields: {
    email: { stringValue: email }, name: { stringValue: name }, role: { stringValue: role }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  await page.reload();
  return page;
}

test('members vote once; admin plans a session from the rota; presenter adds summary and slides', async ({ browser }) => {
  const admin = await signInAs(browser, 'chief@example.org', 'Chief Admin', 'admin');
  const res = await signInAs(browser, 'res@example.org', 'Ada Resident', 'member');
  for (const [id, title] of [['pa', 'Tranexamic acid in hip fracture'], ['pb', 'Sugammadex and pulmonary complications']]) {
    const r = await admin.request.patch(`${REST}/papers/${id}`, { headers: owner, data: { fields: {
      title: { stringValue: title }, year: { integerValue: '2024' }, tags: { arrayValue: {} }, addedBy: { stringValue: 'x' } } } });
    expect(r.ok()).toBeTruthy();
  }

  // Vote: one vote per paper, shown in the count, and the button flips to undo.
  await res.goto('/?emulator#/vote');
  await expect(res.getByRole('heading', { name: 'Vote' })).toBeVisible();
  await res.getByRole('button', { name: 'Vote for Sugammadex and pulmonary complications' }).click();
  await expect(res.getByRole('button', { name: 'Remove vote for Sugammadex and pulmonary complications' })).toBeVisible();
  await expect(res.getByLabel('1 votes')).toBeVisible();
  // The rules refuse a second vote on the same paper.
  const again = await res.evaluate(async () => {
    const { db, doc, setDoc, auth } = window.__jc;
    try { await setDoc(doc(db, 'papers', 'pb', 'votes', auth.currentUser.uid), { at: new Date() }); return 'saved'; }
    catch (e) { return e.code; }
  });
  expect(again).toBe('permission-denied');
  // A member can't touch the rota.
  await res.goto('/?emulator#/rota');
  await expect(res.getByRole('heading', { name: 'Presenter rota' })).toBeVisible();
  await expect(res.getByRole('button', { name: 'Rebuild from members' })).toHaveCount(0);

  // Admin builds the rota (A–Z: Ada sorts first) and plans a session with the most-voted paper preselected.
  await admin.goto('/?emulator#/rota');
  await admin.getByRole('button', { name: 'Rebuild from members' }).click();
  await expect(admin.getByText('→ Ada Resident')).toBeVisible();
  await admin.goto('/?emulator#/sessions');
  await expect(admin.getByRole('heading', { name: 'Plan a session' })).toBeVisible();
  const day = new Date(Date.now() + 7 * 86400000);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await admin.getByLabel('Date').fill(iso);
  await expect(admin.getByLabel('Paper')).toHaveValue('pb');
  await expect(admin.getByLabel('Presenter')).toHaveValue('0');
  await admin.getByRole('button', { name: 'Create session' }).click();
  await expect(admin.getByText('Presenter: Ada Resident')).toBeVisible();
  await expect(admin.getByRole('link', { name: 'Sugammadex and pulmonary complications' })).toBeVisible();
  // The rota moves on past the booked presenter (other tests' members share the emulator, so don't name who is next).
  await admin.goto('/?emulator#/rota');
  await expect(admin.getByText('Ada Resident')).toBeVisible();
  await expect(admin.getByText('→ Ada Resident')).toHaveCount(0);

  // Home shows the next session; the presenter fills in the session page.
  await res.goto('/?emulator#/home');
  await expect(res.getByRole('heading', { name: 'Next session' })).toBeVisible();
  await expect(res.getByText('Sugammadex and pulmonary complications')).toBeVisible();
  await res.locator('#next a').click();
  await expect(res.getByText('Presenter: Ada Resident')).toBeVisible();
  await res.getByLabel('Summary').fill('Reversal choice and PPCs: no difference in the primary outcome.');
  await res.getByLabel('Slides link').fill('https://example.org/slides');
  await res.getByRole('button', { name: 'Save' }).click();
  await expect(res.locator('#ssum')).toHaveText('Reversal choice and PPCs: no difference in the primary outcome.');
  await expect(res.getByRole('link', { name: 'Open slides' })).toHaveAttribute('href', 'https://example.org/slides');
  // A presented paper leaves the vote list.
  await res.goto('/?emulator#/vote');
  await expect(res.getByRole('button', { name: 'Vote for Tranexamic acid in hip fracture' })).toBeVisible();
  await expect(res.getByText('Sugammadex and pulmonary complications')).toHaveCount(0);
});
