import { test, expect, PROJECT, DOCS } from './emu.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const DAY = 86400000;
const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });

async function signIn(browser, email, name, role) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: { stringValue: email }, name: { stringValue: name }, role: { stringValue: role }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#tabs')).toBeVisible({ timeout: 15000 });
  return page;
}

async function put(page, path, fields) {
  const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } });
  expect(r.ok()).toBeTruthy();
}

test('past session opens a SESSION page; its paper opens with the abstract in view; Library defaults to Recently discussed and remembers a change', async ({ browser }) => {
  const admin = await signIn(browser, 'sess-admin@example.org', 'Sess Admin', 'admin');
  const now = Date.now();
  const abstract = 'Background: Long abstracts stay open. '.repeat(1) + 'Methods: We looked at things. Results: They were fine. Conclusions: Open by default.';
  const paper = (title, addedAgo, presented) => ({
    title: { stringValue: title }, journal: { stringValue: 'Anaesthesia' }, year: { integerValue: '2024' }, doi: { stringValue: '10.1/x' },
    abstract: { stringValue: abstract }, tags: { arrayValue: { values: [{ stringValue: 'airway' }, { stringValue: 'trial' }] } },
    addedBy: { stringValue: 'x' }, addedAt: ts(now - addedAgo * DAY), changedAt: ts(now - addedAgo * DAY),
    presented: { arrayValue: { values: presented.map(([sid, d]) => ({ mapValue: { fields: { sid: { stringValue: sid }, date: ts(d) } } })) } },
  });
  await put(admin, 'papers/older', paper('Older paper discussed long ago', 90, [['s1', now - 20 * DAY]]));
  await put(admin, 'papers/newest', paper('Newest paper never discussed', 1, []));
  await put(admin, 'papers/recent', paper('Recently discussed paper', 60, [['s3', now - 3 * DAY]]));
  for (const [sid, pid, title, ago] of [['s1', 'older', 'Older paper discussed long ago', 20], ['s3', 'recent', 'Recently discussed paper', 3]]) {
    await put(admin, `sessions/${sid}`, { date: ts(new Date(now - ago * DAY).setHours(0, 0, 0, 0)), paperId: { stringValue: pid }, paperTitle: { stringValue: title },
      presenterName: { stringValue: 'Pat Presenter' }, summary: { stringValue: '' }, slides: { stringValue: '' } });
  }

  const mem = await signIn(browser, 'sess-mem@example.org', 'Sess Member', 'member');
  // Library opens on Recently discussed: the paper discussed 3 days ago first, then 20 days ago, then the rest newest added.
  await mem.goto(`/?emulator=${PROJECT}#/library`);
  await expect(mem.locator('#count')).toHaveText('3 papers · Recently discussed');
  await expect(mem.locator('#res li.paper a').first()).toHaveText('Recently discussed paper');
  await expect(mem.locator('#res li.paper').nth(1).locator('a').first()).toHaveText('Older paper discussed long ago');
  await expect(mem.locator('#res li.paper').nth(2).locator('a').first()).toHaveText('Newest paper never discussed');

  // The Presented badge goes to the session.
  await mem.locator('#res li.paper').first().locator('a.badge').click();
  await expect(mem.locator('.eyebrow').first()).toHaveText('SESSION');
  await expect(mem).toHaveTitle(/^Session /);

  // Club: tapping a past session's paper title opens the session page, with a paper card below.
  await mem.goto(`/?emulator=${PROJECT}#/home`);
  await mem.locator('#past li.paper').first().getByRole('link', { name: 'Recently discussed paper' }).click();
  await expect(mem).toHaveURL(/#\/session\/s3$/);
  await expect(mem.locator('.eyebrow').first()).toHaveText('SESSION');
  await expect(mem.locator('.session-head')).toContainText('Pat Presenter');
  await expect(mem.locator('#spaper')).toContainText('Recently discussed paper');
  await expect(mem.locator('#spaper')).toContainText('Anaesthesia · 2024');

  // Its paper: PAPER eyebrow, abstract open and above the fold at 390 x 844.
  await mem.locator('#openpaper').click();
  await expect(mem.locator('.eyebrow').first()).toHaveText('PAPER');
  await expect(mem).toHaveTitle(/^Recently discussed paper · Paper/);
  const ab = mem.locator('.abstract-open .abstract');
  await expect(ab).toBeVisible();
  await expect(ab).toContainText('Conclusions: Open by default.');
  const box = await ab.boundingBox();
  expect(box.y + 40).toBeLessThan(844);
  await expect(mem.getByRole('button', { name: 'Edit details' })).toBeVisible();

  // A chosen sort is remembered.
  await mem.goto(`/?emulator=${PROJECT}#/library`);
  await mem.locator('#sortb').click();
  await mem.getByRole('dialog', { name: 'Sort' }).getByRole('radio', { name: 'Newest added' }).click();
  await expect(mem.locator('#count')).toHaveText('3 papers · Newest added');
  await mem.reload();
  await expect(mem.locator('#count')).toHaveText('3 papers · Newest added');
  await expect(mem.locator('#res li.paper a').first()).toHaveText('Newest paper never discussed');
});
