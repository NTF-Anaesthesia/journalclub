import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const DAY = 86400000;
const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const s = (v) => ({ stringValue: v });
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function signIn(browser, email, name, role = 'member') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s(name), role: s(role), inviteId: s('seed') } } });
  expect(seed.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator('#tabs')).toBeVisible({ timeout: 15000 });
  return { page, uid };
}

// A search as `who`, answered by the one Worker stand-in (on A's page) with that member's token.
const searchAs = async (a, who, q) => {
  const token = await who.page.evaluate(() => window.__jc.auth.currentUser.getIdToken());
  return a.page.evaluate(async ([t, qq]) => (await fetch(`/api/search?q=${qq}`, { headers: { Authorization: `Bearer ${t}` } })).json(), [token, q]);
};

async function put(page, path, fields) {
  const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } });
  expect(r.ok()).toBeTruthy();
}

test('paper notes are private by default; Members shares one; the dot, My notes and the journal club card follow', async ({ browser }) => {
  const a = await signIn(browser, 'notes-a@example.org', 'Ann Author');
  const b = await signIn(browser, 'notes-b@example.org', 'Ben Reader');
  await workerApi(a.page, PROJECT);
  const now = Date.now();
  await put(a.page, 'papers/pp1', { title: s('Caudal blocks in children'), journal: s('Anaesthesia'), year: { integerValue: '2024' }, abstract: s('Background: x.'),
    tags: { arrayValue: { values: [] } }, addedBy: s(a.uid), addedAt: ts(now - 30 * DAY), changedAt: ts(now - 30 * DAY),
    file: { mapValue: { fields: { pages: { integerValue: '3' } } } },
    presented: { arrayValue: { values: [{ mapValue: { fields: { sid: s('sx1'), date: ts(now - 3 * DAY) } } }] } } });
  await put(a.page, 'papers/pp2', { title: s('Never presented paper'), journal: s('BJA'), year: { integerValue: '2023' },
    tags: { arrayValue: { values: [] } }, addedBy: s(a.uid), addedAt: ts(now - 20 * DAY), changedAt: ts(now - 20 * DAY) });
  await put(a.page, 'sessions/sx1', { date: ts(now - 3 * DAY), paperId: s('pp1'), paperTitle: s('Caudal blocks in children'), presenterName: s('Pat Presenter'), summary: s(''), slides: s(''),
    slidesFile: { mapValue: { fields: { name: s('talk.pdf'), size: { integerValue: '10' }, kind: s('pdf'), pdf: { booleanValue: true } } } } });
  await put(a.page, 'sessions/sx0', { date: ts(now - 40 * DAY), paperId: s('pp1'), paperTitle: s('Caudal blocks in children'), presenterName: s('Old Presenter'), summary: s(''), slides: s('') });
  await put(a.page, `users/${a.uid}/sessionNotes/sx1`, { text: s('Ask about the dose by weight'), updatedAt: ts(now) });

  // A writes a note: Only me is the default, and nobody else sees it.
  await a.page.goto(`/?emulator=${PROJECT}#/paper/pp1`);
  await expect(a.page.getByLabel('Only me')).toBeChecked();
  await a.page.getByLabel('Your note').fill('Private musings about zebrafish');
  await a.page.getByRole('button', { name: 'Save note' }).click();
  await expect(a.page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(a.page.getByLabel('Only me')).toBeChecked();

  await b.page.goto(`/?emulator=${PROJECT}#/paper/pp1`);
  await expect(b.page.getByRole('heading', { name: 'Caudal blocks in children' })).toBeVisible();
  await expect(b.page.getByText('Private musings about zebrafish')).toHaveCount(0);
  await expect(b.page.getByLabel('Only me')).toBeChecked();
  expect(await noSideScroll(b.page)).toBe(true);
  // Search finds no private note for anyone, A included.
  for (const who of [a, b]) {
    expect((await searchAs(a, who, 'zebrafish')).hits).toEqual([]);
  }

  // A shares a second note: B reads it on the page and finds it in search.
  await a.page.getByLabel('Members', { exact: true }).check();
  await a.page.getByLabel('Your note').fill('Sharing this note about caudal catheters');
  await a.page.getByRole('button', { name: 'Save note' }).click();
  await expect(a.page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await b.page.reload();
  await expect(b.page.getByText('Sharing this note about caudal catheters')).toBeVisible();
  await expect(b.page.getByText('Ann Author')).toBeVisible();
  const hit = await searchAs(a, b, 'catheters');
  expect(hit.hits.map((h) => [h.paperId, h.page])).toEqual([['pp1', 0]]);
  // Switching back to Only me hides it again and removes it from search.
  await a.page.getByLabel('Only me').check();
  await a.page.getByRole('button', { name: 'Save note' }).click();
  await expect(a.page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await b.page.reload();
  await expect(b.page.getByText('Sharing this note about caudal catheters')).toHaveCount(0);
  await expect(async () => {
    expect((await searchAs(a, b, 'catheters')).hits).toEqual([]);
  }).toPass();

  // Journal club card: latest session, Slides pill to the reader, my private session note, "1 earlier".
  await a.page.reload();
  const card = a.page.locator('.jc-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Pat Presenter');
  await expect(card).toContainText('Ask about the dose by weight');
  await expect(card.getByRole('link', { name: 'Open the slides' })).toHaveAttribute('href', '#/view/sess_sx1');
  await expect(card.getByRole('button', { name: '1 earlier' })).toBeVisible();
  expect(await noSideScroll(a.page)).toBe(true);
  await card.locator('.jc-notes').click();
  await expect(a.page).toHaveURL(/#\/session\/sx1$/);
  await a.page.goto(`/?emulator=${PROJECT}#/paper/pp2`);
  await expect(a.page.getByRole('heading', { name: 'Never presented paper' })).toBeVisible();
  await expect(a.page.locator('.jc-card')).toHaveCount(0);
  // Open PDF sits in the action row with Star.
  await a.page.goto(`/?emulator=${PROJECT}#/paper/pp1`);
  await expect(a.page.locator('.actions.compact').getByRole('button', { name: 'Open PDF' })).toBeVisible();

  // The dot on Library rows with my note, and not on the other member's.
  await a.page.goto(`/?emulator=${PROJECT}#/library`);
  await expect(a.page.locator('#res li.paper', { hasText: 'Caudal blocks in children' }).locator('.note-dot')).toBeVisible();
  await expect(a.page.locator('#res li.paper', { hasText: 'Never presented' }).locator('.note-dot')).toHaveCount(0);
  await expect(a.page.locator('#res li.paper', { hasText: 'Caudal blocks in children' }).getByRole('link', { name: 'Open the session slides' })).toHaveAttribute('href', '#/view/sess_sx1');
  await b.page.goto(`/?emulator=${PROJECT}#/library`);
  await expect(b.page.locator('#res li.paper').first()).toBeVisible();
  await expect(b.page.locator('.note-dot')).toHaveCount(0);

  // Saved > My notes: my paper note and my session note, searchable.
  await a.page.goto(`/?emulator=${PROJECT}#/lists`);
  const mine = a.page.locator('#mynotes');
  await expect(mine.getByText('Private musings about zebrafish').or(mine.getByText('Sharing this note about caudal catheters'))).toBeVisible();
  await expect(mine.locator('li.mynote')).toHaveCount(2);
  await a.page.getByLabel('Search my notes').fill('dose weight');
  await expect(mine.locator('li.mynote')).toHaveCount(1);
  await expect(mine).toContainText('Session note');
  await a.page.getByLabel('Search my notes').fill('nothing like this');
  await expect(mine).toContainText('No note matches');
  expect(await noSideScroll(a.page)).toBe(true);
  // B has none.
  await b.page.goto(`/?emulator=${PROJECT}#/lists`);
  await expect(b.page.locator('#mynotes')).toContainText('Notes you write on papers and sessions show here.');
});
