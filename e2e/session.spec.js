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

test('session page: paper card, take-home first, live points with me-too, private notes, menu; Club shows take-home lines', async ({ browser }) => {
  const now = Date.now();
  const A = await signIn(browser, 'sp-a@example.org', 'Ada Presenter', 'member');
  const B = await signIn(browser, 'sp-b@example.org', 'Ben Member', 'member');
  const uidA = await A.evaluate(() => window.__jc.auth.currentUser.uid);
  const uidB = await B.evaluate(() => window.__jc.auth.currentUser.uid);
  const strs = (a) => ({ arrayValue: { values: a.map((x) => ({ stringValue: x })) } });
  await put(A, 'papers/pp', { title: { stringValue: 'Remimazolam versus propofol for induction' }, journal: { stringValue: 'Anaesthesia' }, year: { integerValue: '2025' },
    authors: strs(['Lee A', 'Tan B', 'Wong C', 'Lim D']), tags: strs([]), addedBy: { stringValue: 'x' }, addedAt: ts(now), changedAt: ts(now),
    file: { mapValue: { fields: { pages: { integerValue: '5' } } } } });
  await put(A, 'papers/pq', { title: { stringValue: 'A paper with no note or PDF' }, tags: strs([]), addedBy: { stringValue: 'x' }, addedAt: ts(now), changedAt: ts(now) });
  await put(A, `papers/pp/notes/${uidA}`, { text: { stringValue: 'Line one of my note.\nLine two.\nLine three.\nLine four hidden.' }, rating: { integerValue: '0' }, name: { stringValue: 'Ada' }, updatedAt: ts(now) });
  const sess = { date: ts(new Date(now + 3 * DAY).setHours(0, 0, 0, 0)), presenterUid: { stringValue: uidA }, presenterName: { stringValue: 'Ada Presenter' },
    summary: { stringValue: 'A short summary.' }, slides: { stringValue: '' }, createdBy: { stringValue: uidA } };
  await put(A, 'sessions/ss1', { ...sess, paperId: { stringValue: 'pp' }, paperTitle: { stringValue: 'Remimazolam versus propofol for induction' },
    slidesFile: { mapValue: { fields: { name: { stringValue: 'talk.pdf' }, size: { integerValue: '1000' }, kind: { stringValue: 'pdf' }, pdf: { booleanValue: true } } } },
    discussion: { mapValue: { fields: { answers: { mapValue: { fields: { takehome: strs(['Faster recovery', 'Less hypotension', 'Third point']) } } } } } } });
  await put(A, 'sessions/ss2', { ...sess, paperId: { stringValue: 'pq' }, paperTitle: { stringValue: 'A paper with no note or PDF' } });

  // Paper card: whole card is the link, no Open paper button, authors cut to three, my note clamped, PDF pill to the reader.
  await A.goto(`/?emulator=${PROJECT}#/session/ss1`);
  await expect(A.locator('#spaper')).toContainText('Lee A, Tan B, Wong C et al.');
  await expect(A.locator('#spaper')).toContainText('Anaesthesia · 2025');
  await expect(A.getByRole('link', { name: 'Open paper' })).toHaveCount(0);
  await expect(A.locator('#spaper .note-peek')).toContainText('Line one of my note.');
  await expect(A.locator('#spdfpill')).toHaveAttribute('href', '#/read/pp');
  await expect(A.locator('#stake')).toContainText('Faster recovery');
  expect(await A.locator('#stake').evaluate((e) => e.compareDocumentPosition(document.querySelector('#ssum')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  await expect(A.getByText('Scan to add')).toHaveCount(0);
  await expect(A.locator('.qr')).toHaveCount(0);
  await expect(A.getByRole('link', { name: 'Open slides' })).toHaveAttribute('href', '#/view/sess_ss1');
  const box = await A.locator('#spaper').boundingBox();
  await A.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  await expect(A).toHaveURL(/#\/paper\/pp$/);
  await A.goBack();
  await A.locator('#spdfpill').click();
  await expect(A).toHaveURL(/#\/read\/pp/);
  await B.goto(`/?emulator=${PROJECT}#/session/ss2`);
  await expect(B.locator('#spaper .note-peek')).toHaveText('Add a note');
  await expect(B.locator('#spdfpill')).toHaveCount(0);

  // Points: B shares one; A (page already open) sees it without a reload.
  await A.goto(`/?emulator=${PROJECT}#/session/ss1`);
  await expect(A.locator('#spaper')).toContainText('Remimazolam');
  await expect(A.locator('#spts')).toContainText('None yet.');
  await B.goto(`/?emulator=${PROJECT}#/session/ss1`);
  await expect(B.locator('#spaper')).toContainText('Remimazolam'); // the new page, not the previous one still on screen
  await expect(B.locator('#sshare')).toHaveText('Share your point');
  await expect(B.locator('#sshare2')).toContainText('Add yours if you missed the discussion');
  await B.locator('#sshare-low').click();
  const dlg = B.getByRole('dialog', { name: 'Share your point' });
  await dlg.getByLabel('Your take-home point').fill('Watch the blood pressure');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(B.locator('#spts')).toContainText('Ben Member (you)');
  await expect(B.locator('#sshare')).toHaveText('Edit your point');
  await expect(A.locator('#spts')).toContainText('Watch the blood pressure');
  // A adds one too, then agrees with B's: B's point ranks first, B sees +1 without reloading.
  await A.locator('#sshare').click();
  await A.getByRole('dialog', { name: 'Share your point' }).getByLabel('Your take-home point').fill('Check the dose');
  await A.getByRole('dialog', { name: 'Share your point' }).getByRole('button', { name: 'Save' }).click();
  await expect(A.locator('#spts li')).toHaveCount(2);
  await A.locator('#spts li', { hasText: 'Watch the blood pressure' }).getByRole('button', { name: /I agree/ }).click();
  await expect(A.locator('#spts li').first()).toContainText('Watch the blood pressure');
  await expect(A.locator('#spts li').first().locator('.plus-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(B.locator('#spts li').first().locator('.pt-acts')).toContainText('+1');
  await expect(B.locator('#spts li').first().locator('.plus-btn')).toHaveCount(0);
  // Withdraw.
  await A.locator('#spts li', { hasText: 'Watch the blood pressure' }).getByRole('button', { name: /Withdraw/ }).click();
  await expect(B.locator('#spts li', { hasText: 'Watch the blood pressure' }).locator('.pt-acts')).not.toContainText('+1');
  // Own point: inline edit and delete, one point per member.
  await B.getByRole('button', { name: 'Edit your point', exact: true }).first().click();
  const ed = B.getByRole('dialog', { name: 'Edit your point' });
  await expect(ed.getByLabel('Your take-home point')).toHaveValue('Watch the blood pressure');
  await ed.getByLabel('Your take-home point').fill('Watch the pressure closely');
  await ed.getByRole('button', { name: 'Update' }).click();
  await expect(B.locator('#spts')).toContainText('Watch the pressure closely');
  await expect(B.locator('#spts li')).toHaveCount(2);
  await expect(A.locator('#spts')).toContainText('Watch the pressure closely');
  B.once('dialog', (d) => d.accept());
  await B.locator('#spts li', { hasText: 'Watch the pressure closely' }).getByRole('button', { name: 'Delete your point' }).click();
  await expect(B.locator('#spts li')).toHaveCount(1);
  await expect(A.locator('#spts li')).toHaveCount(1);

  // Overflow menu.
  await A.getByRole('button', { name: 'More actions' }).click();
  const menu = A.getByRole('dialog', { name: 'Session actions' });
  await expect(menu.getByRole('button')).toHaveText(['Edit session', 'Refresh', 'Copy as text', 'Print / PDF']);
  await expect(menu).toBeVisible();
  await A.screenshot({ path: 'test-results/s11a-menu.png' });
  const before = await A.locator('#spts').elementHandle();
  await menu.getByRole('button', { name: 'Refresh' }).click();
  await A.waitForFunction((el) => !el.isConnected, before); // the page was re-read and redrawn
  await expect(A.locator('#spts')).toContainText('Check the dose');

  // My notes: autosave, "Saved", kept on reload; stored under my own user doc only.
  await A.getByLabel('My notes on this session').fill('Ask about the sample size');
  await expect(A.locator('#mynotemsg')).toHaveText('Saved ✓');
  await A.reload();
  await expect(A.getByLabel('My notes on this session')).toHaveValue('Ask about the sample size');
  await expect(B.getByLabel('My notes on this session')).toHaveValue('');
  expect((await A.request.get(`${DOCS}/users/${uidA}/sessionNotes/ss1`, { headers: owner })).ok()).toBeTruthy();
  expect((await B.request.get(`${DOCS}/users/${uidB}/sessionNotes/ss1`, { headers: owner })).status()).toBe(404);
  await A.screenshot({ path: 'test-results/s11a-session.png', fullPage: true });

  // Club: the first two take-home points under the session card.
  await A.goto(`/?emulator=${PROJECT}#/home`);
  await expect(A.locator('#next')).toContainText('Faster recovery');
  await expect(A.locator('#next')).toContainText('Less hypotension');
  await expect(A.locator('#next')).not.toContainText('Third point');
  await A.screenshot({ path: 'test-results/s11a-club.png', fullPage: true });
});
