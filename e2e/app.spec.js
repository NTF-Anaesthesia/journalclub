import { test, expect, PROJECT, DOCS } from './emu.js';

test.use({ viewport: { width: 390, height: 844 } });

test('stranger sees the sign-in page and no member content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Join the club' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByText('Admin')).toHaveCount(0);
  await page.goto('/#/admin');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
});

test('stranger opening an invite link is asked to sign in first', async ({ page }) => {
  await page.goto('/#/join/whatever');
  await expect(page.getByText('Sign in with Google to accept your invite.')).toBeVisible();
});

test('admin invites, a newcomer joins once, the link then dies', async ({ page, browser }) => {
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => {
    await window.__jc.signIn('boss@example.org');
    return window.__jc.auth.currentUser.uid;
  });
  // Seed the first admin the way the real project is seeded: out of band, bypassing rules (emulator owner token).
  const seed = await page.request.patch(
    `${DOCS}/members/${uid}`,
    { headers: { Authorization: 'Bearer owner' }, data: { fields: {
      email: { stringValue: 'boss@example.org' }, name: { stringValue: 'Boss' }, role: { stringValue: 'admin' }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  await page.goto(`/?emulator=${PROJECT}#/admin`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await page.getByPlaceholder('Note (who it is for)').fill('new resident');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.locator('#linktext').innerText();
  const token = link.split('/#/join/')[1];
  expect(token.length).toBeGreaterThan(20);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx.newPage();
  await p2.goto(`/?emulator=${PROJECT}`);
  await p2.evaluate(() => window.__jc.signIn('new@example.org'));
  await p2.goto(`/?emulator=${PROJECT}#/join/${token}`);
  await p2.reload();
  await expect(p2.getByText('Join as new@example.org?')).toBeVisible();
  await p2.getByRole('button', { name: 'Accept invite' }).click();
  await expect(p2.getByRole('heading', { name: 'Club', exact: true })).toBeVisible();
  await expect(p2.locator('#tabs .app-tab')).toHaveText(['Club', 'Calendar', 'Library', 'Saved', 'Settings']);
  await expect(p2.getByText('Admin', { exact: true })).toHaveCount(0);

  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(`/?emulator=${PROJECT}`);
  await p3.evaluate(() => window.__jc.signIn('third@example.org'));
  await p3.goto(`/?emulator=${PROJECT}#/join/${token}`);
  await p3.reload();
  await expect(p3.getByText(/not valid any more/)).toBeVisible();
});
