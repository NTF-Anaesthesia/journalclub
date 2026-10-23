import { test, expect, PROJECT, DOCS } from './emu.js';

test.use({ viewport: { width: 390, height: 844 } });

const REST = DOCS;
const owner = { Authorization: 'Bearer owner' };

async function signInAs(browser, email, name, role) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(`${REST}/members/${uid}`, { headers: owner, data: { fields: {
    email: { stringValue: email }, name: { stringValue: name }, role: { stringValue: role }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#tabs')).toBeVisible({ timeout: 15000 });
  page.uid = uid;
  return page;
}

const seedPaper = async (page, id, title, addedBy) => {
  const r = await page.request.patch(`${REST}/papers/${id}`, { headers: owner, data: { fields: {
    title: { stringValue: title }, year: { integerValue: '2024' }, tags: { arrayValue: {} }, addedBy: { stringValue: addedBy }, changedAt: { timestampValue: new Date().toISOString() } } } });
  expect(r.ok()).toBeTruthy();
};

test('member flags a paper; admin dismisses one flag and removes the other paper on the removal page', async ({ browser }) => {
  const admin = await signInAs(browser, 'chief2@example.org', 'Chief Admin', 'admin');
  const mem = await signInAs(browser, 'flagger@example.org', 'Flo Flagger', 'member');
  await seedPaper(admin, 'r1', 'Paper to keep', 'someone');
  await seedPaper(admin, 'r2', 'Paper to remove', 'someone');

  // The old inline delete controls are gone; a non-owner member only sees the flag box.
  await mem.goto(`/?emulator=${PROJECT}#/paper/r2`);
  await expect(mem.getByRole('heading', { name: 'Paper to remove' })).toBeVisible();
  await expect(mem.getByText('Delete paper')).toHaveCount(0);
  await expect(mem.getByText('Remove PDF')).toHaveCount(0);
  await expect(mem.getByText('Remove this paper or its PDF…')).toHaveCount(0);
  await mem.goto(`/?emulator=${PROJECT}#/remove/r2`);
  await expect(mem.getByText('Only the person who added this paper, or an admin, can remove it.')).toBeVisible();

  for (const [id, title] of [['r1', 'Paper to keep'], ['r2', 'Paper to remove']]) {
    await mem.goto(`/?emulator=${PROJECT}#/paper/${id}`);
    await expect(mem.getByRole('heading', { name: title })).toBeVisible();
    await mem.getByText('Flag for removal').click();
    await mem.getByLabel('Reason').fill('Copyright concern');
    await mem.getByRole('button', { name: 'Send flag' }).click();
    await expect(mem.getByText('Thanks. An admin will review it.')).toBeVisible();
  }

  await admin.goto(`/?emulator=${PROJECT}#/admin`);
  await expect(admin.getByRole('heading', { name: 'Removal flags' })).toBeVisible();
  await expect(admin.getByText('Copyright concern')).toHaveCount(2);
  await expect(admin.getByText('whole paper · Flo Flagger').first()).toBeVisible();
  // Dismiss the flag on the paper to keep.
  await admin.locator('#flags li', { hasText: 'Paper to keep' }).getByRole('button', { name: 'Dismiss' }).click();
  await expect(admin.getByText('Copyright concern')).toHaveCount(1);
  // Remove opens the removal page; the button needs the exact title.
  await admin.locator('#flags li', { hasText: 'Paper to remove' }).getByRole('button', { name: 'Remove' }).click();
  await expect(admin.getByRole('heading', { name: 'Remove', exact: true })).toBeVisible();
  const go = admin.getByRole('button', { name: 'Remove paper' });
  await expect(go).toBeDisabled();
  await admin.getByLabel('Type the paper title').fill('Paper to');
  await expect(go).toBeDisabled();
  await admin.getByLabel('Type the paper title').fill('paper to remove');
  await expect(go).toBeEnabled();
  await go.click();
  await expect(admin.getByLabel('Search the library')).toBeVisible();
  await admin.goto(`/?emulator=${PROJECT}#/paper/r2`);
  await expect(admin.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await admin.goto(`/?emulator=${PROJECT}#/admin`);
  await expect(admin.getByText('No open flags.')).toBeVisible();
  await admin.goto(`/?emulator=${PROJECT}#/paper/r1`);
  await expect(admin.getByRole('heading', { name: 'Paper to keep' })).toBeVisible();
});

test('the person who added a paper reaches the removal page from the paper page', async ({ browser }) => {
  const mem = await signInAs(browser, 'adder@example.org', 'Ann Adder', 'member');
  await seedPaper(mem, 'r3', 'Mine to remove', mem.uid);
  await mem.goto(`/?emulator=${PROJECT}#/paper/r3`);
  await mem.getByText('Edit', { exact: true }).click();
  await mem.getByRole('link', { name: 'Remove this paper or its PDF…' }).click();
  await expect(mem.getByRole('heading', { name: 'Remove', exact: true })).toBeVisible();
  await expect(mem.getByRole('button', { name: 'Remove PDF' })).toHaveCount(0); // no PDF stored
  await mem.getByLabel('Type the paper title').fill('Mine to remove');
  await mem.getByRole('button', { name: 'Remove paper' }).click();
  await expect(mem.getByLabel('Search the library')).toBeVisible();
});

test('group link: many join, admin sees who, revoking stops new joins; single-use links still work', async ({ browser }) => {
  const admin = await signInAs(browser, 'chief3@example.org', 'Chief Admin', 'admin');
  await admin.goto(`/?emulator=${PROJECT}#/admin`);
  await admin.getByPlaceholder('Note (who it is for)').fill('July residents');
  await admin.getByRole('button', { name: 'Create group link' }).click();
  const link = await admin.locator('#linktext').innerText();
  expect(await admin.getByText(/^Group link:/).count()).toBe(1);
  const token = link.split('/#/join/')[1];

  for (const email of ['g1@example.org', 'g2@example.org']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await p.goto(`/?emulator=${PROJECT}`);
    await p.evaluate((e) => window.__jc.signIn(e), email);
    await p.goto(`/?emulator=${PROJECT}#/join/${token}`);
    await p.reload();
    await expect(p.getByText(`Join as ${email}?`)).toBeVisible();
    await p.getByRole('button', { name: 'Accept invite' }).click();
    await expect(p.getByLabel('Search the library')).toBeVisible();
  }

  await admin.reload();
  const row = admin.locator('#invites li', { hasText: 'July residents' });
  await expect(row).toContainText('Group');
  await expect(row).toContainText('g1@example.org');
  await expect(row).toContainText('g2@example.org');

  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(admin.locator('#invites li', { hasText: 'July residents' })).toHaveCount(0);
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p3 = await ctx3.newPage();
  await p3.goto(`/?emulator=${PROJECT}`);
  await p3.evaluate(() => window.__jc.signIn('late@example.org'));
  await p3.goto(`/?emulator=${PROJECT}#/join/${token}`);
  await p3.reload();
  await expect(p3.getByText(/not valid any more/)).toBeVisible();
});
