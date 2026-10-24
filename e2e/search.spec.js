import { test, expect, PROJECT, DOCS } from './emu.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const arr = (xs) => ({ arrayValue: { values: xs.map(s) } });

async function put(page, path, fields) {
  const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } });
  expect(r.ok()).toBeTruthy();
}

test('search: operators, OR, phrases, exclusions; suggestions; saved search chip synced; slides pill on presented papers', async ({ browser }) => {
  test.setTimeout(60000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('search.mem@example.org'); return window.__jc.auth.currentUser.uid; });
  await put(page, `members/${uid}`, { email: s('search.mem@example.org'), name: s('Search Mem'), role: s('member'), inviteId: s('seed') });
  const now = Date.now();
  const paper = (title, authors, journal, year, tags, abstract, presented = []) => ({
    title: s(title), authors: arr(authors), journal: s(journal), year: { integerValue: String(year) }, tags: arr(tags), abstract: s(abstract),
    addedBy: s('x'), addedAt: ts(now - year), changedAt: ts(now - year),
    presented: { arrayValue: { values: presented.map((sid) => ({ mapValue: { fields: { sid: s(sid), date: ts(now - 86400000) } } })) } },
  });
  await put(page, 'papers/q1', paper('Sugammadex versus neostigmine for reversal', ['Ann Lee'], 'Anaesthesia', 2021, ['reversal', 'airway'], 'Residual blockade was lower.', ['sx1']));
  await put(page, 'papers/q2', paper('Post dural puncture headache in obstetrics', ['Cara Tan'], 'IJOA', 2015, ['obstetric'], 'Epidural blood patch.', ['sx2']));
  await put(page, 'papers/q3', paper('Neostigmine dosing study', ['Dan Lee'], 'BJA', 2024, [], 'Dose finding for reversal.'));
  await put(page, 'sessions/sx1', { date: ts(now - 86400000), paperId: s('q1'), paperTitle: s('Sugammadex versus neostigmine for reversal'),
    presenterName: s('P'), summary: s(''), slides: s(''), slidesFile: { mapValue: { fields: { kind: s('pdf'), name: s('talk.pdf'), pdf: s('slides/sx1/original') } } } });
  await put(page, 'sessions/sx2', { date: ts(now - 86400000), paperId: s('q2'), paperTitle: s('Post dural puncture headache in obstetrics'),
    presenterName: s('P'), summary: s(''), slides: s('https://example.org/deck') });
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload(); // signed in as a member now, with everything seeded
  await expect(page.locator('#count')).toHaveText(/^3 papers/, { timeout: 15000 });
  const box = page.getByLabel('Search the library');
  const titles = () => page.locator('#res li.paper > a').allInnerTexts();

  // Slides: an uploaded deck opens from a button, a linked one is a link; both beside "Presented".
  await expect(page.locator('#res li.paper', { hasText: 'Sugammadex' }).locator('.pills .slides-pill')).toHaveText('Slides');
  await expect(page.locator('#res li.paper', { hasText: 'dural' }).locator('.pills a.pdf-pill', { hasText: 'Slides' })).toHaveAttribute('href', 'https://example.org/deck');
  await expect(page.locator('#res li.paper', { hasText: 'dosing' }).locator('.pills', { hasText: 'Slides' })).toHaveCount(0);

  // Operators alone narrow the list; free words, OR, phrases and -words search.
  await box.fill('author:lee');
  await expect.poll(titles).toEqual(expect.arrayContaining(['Sugammadex versus neostigmine for reversal', 'Neostigmine dosing study']));
  await expect(page.locator('#count')).toHaveText(/^2 papers/);
  await box.fill('author:lee -tag:airway');
  await expect(page.locator('#count')).toHaveText(/^1 paper/);
  await box.fill('has:slides year:<2020');
  await expect.poll(titles).toEqual(['Post dural puncture headache in obstetrics']);
  await box.fill('sugammadex OR headache');
  await expect(page.locator('#count')).toHaveText(/^2 found/);
  await box.fill('"puncture dural"');
  await expect(page.locator('#count')).toHaveText(/^No papers found/);
  await box.fill('"puncture headache"');
  await expect.poll(titles).toEqual(['Post dural puncture headache in obstetrics']);
  await box.fill('reversal -sugammadex');
  await expect.poll(titles).toEqual(['Neostigmine dosing study']);
  await expect(page.locator('#res li.paper mark').first()).toHaveText(/reversal/i); // the word is marked in the abstract snippet

  // Suggestions: typing a field offers its values; a tap fills the box.
  await box.fill('tag:obs');
  await page.locator('#sugg li', { hasText: 'tag:obstetric' }).click();
  await expect(box).toHaveValue('tag:obstetric ');
  await expect(page.locator('#count')).toHaveText(/^1 paper/);

  // Save it: a chip above the list, also on another device (Firestore), and in the empty box's suggestions.
  await page.getByRole('button', { name: 'Save this search' }).click();
  await expect(page.locator('#chips .chip.saved')).toHaveText('tag:obstetric');
  await box.fill('');
  await expect(page.locator('#count')).toHaveText(/^3 papers/);
  await page.locator('#chips .chip.saved').click();
  await expect(box).toHaveValue('tag:obstetric');
  await expect(page.locator('#count')).toHaveText(/^1 paper/);
  const other = await ctx.newPage();
  await other.goto(`/?emulator=${PROJECT}#/library`);
  await expect(other.locator('#chips .chip.saved')).toHaveText('tag:obstetric');
  await box.fill('');
  await box.focus();
  await expect(page.locator('#sugg li', { hasText: 'Saved' })).toContainText('tag:obstetric');
  await page.getByRole('button', { name: 'Remove this saved search' }).click();
  await expect(page.locator('#chips .chip.saved')).toHaveCount(0);

  // Sort while searching: Best match first, any order on request, the search kept.
  await box.fill('neostigmine');
  await page.locator('#sortb').click();
  await page.getByRole('dialog', { name: 'Sort' }).getByRole('radio', { name: 'Year' }).click();
  await expect(box).toHaveValue('neostigmine');
  await expect(page.locator('#count')).toHaveText(/^2 found · Year/);
  await expect.poll(titles).toEqual(['Neostigmine dosing study', 'Sugammadex versus neostigmine for reversal']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ctx.close();
});
