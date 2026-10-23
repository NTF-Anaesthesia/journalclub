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

const ATOTW_OLD = 'ANAESTHESIA TUTORIAL OF THE WEEK 242 9th January 2012 Dr Jane Roe, Specialist Registrar Correspondence to jane@example.org '
  + 'SUMMARY Sedation in the intensive care unit is given to relieve anxiety, to permit tolerance of the endotracheal tube and to reduce '
  + 'oxygen consumption. This tutorial describes the common agents, how depth is scored, and why daily interruption of infusions shortens ventilation. '
  + 'QUESTIONS Before reading this tutorial, please answer the following questions. 1. Which agent accumulates in renal failure?';
// A journal PDF whose DOI is broken across a line, with a title printed on the page.
const JOURNAL = 'PLoS Medicine Essay Why Most Published Research Findings Are False John P. A. Ioannidis Published online https://doi.org/10.1371/journal.pmed.0020124';
const HANDOUT = 'Ward round handout. Who sees which bed, when the registrar joins, how handover is written and who is told. '.repeat(8);

async function signIn(page, email, role = 'member') {
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const r = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s(email.split('@')[0]), role: s(role), inviteId: s('seed') } } });
  expect(r.ok()).toBeTruthy();
  return uid;
}
const seed = (page, id, fields) => page.request.patch(`${DOCS}/papers/${id}`, { headers: owner, data: { fields: {
  doi: s(''), pmid: s(''), abstract: s(''), authors: arr([]), journal: s(''), tags: arr([]), file: FILE, ...fields } } })
  .then((r) => expect(r.ok()).toBeTruthy());
const open = async (page, hash = '') => { await page.goto(`/?emulator=${PROJECT}#/${hash}`); await page.reload(); };
async function longPress(page, locator) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

test('admin Fill missing details: old ATOTW gets the PDF summary, a journal PDF its lookup, leftovers an AI summary; a real abstract is untouched', async ({ page }) => {
  test.setTimeout(90000);
  const w = await workerApi(page, PROJECT);
  const uid = await signIn(page, 'admin.fill@example.org', 'admin');
  await seed(page, 'a1', { title: s('ATOTW 242 sedation'), addedBy: s(uid), addedAt: at(T0 + 1000) });
  await seed(page, 'j1', { title: s('scan 0042'), addedBy: s(uid), addedAt: at(T0 + 2000) });
  await seed(page, 'h1', { title: s('ward round handout'), addedBy: s(uid), addedAt: at(T0 + 3000) });
  await seed(page, 'k1', { title: s('Has a real abstract'), abstract: s('Kept as it is.'), addedBy: s(uid), addedAt: at(T0 + 4000) });
  await seed(page, 'n1', { title: s('No PDF at all'), file: undefined, addedBy: s(uid), addedAt: at(T0 + 5000) });
  await indexPages(w.db, 'a1', [ATOTW_OLD]);
  await indexPages(w.db, 'j1', [JOURNAL]);
  await indexPages(w.db, 'h1', [HANDOUT]);
  await indexPages(w.db, 'k1', ['Some text of a paper that already has an abstract.']);
  await open(page);

  await page.getByRole('button', { name: /^No abstract · 4$/ }).click();
  await expect(page.locator('#res li')).toHaveCount(4);
  await longPress(page, page.locator('#res li').first());
  await page.getByRole('button', { name: 'All 4' }).click();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: /^Fill missing details \(3 PDFs\)$/ }).click();
  const prog = page.getByRole('dialog', { name: 'Filling papers' });
  await expect(prog.getByRole('heading', { name: 'Done: 4 papers' })).toBeVisible({ timeout: 40000 });
  await expect(prog.locator('li', { hasText: 'Abstract from the PDF' })).toContainText('1');
  await expect(prog.locator('li', { hasText: 'Details and abstract from a lookup' })).toContainText('1');
  await expect(prog.locator('li', { hasText: 'AI summary added' })).toContainText('1');
  await expect(prog.locator('li', { hasText: 'No PDF text' })).toContainText('1');
  expect(w.ai.calls).toHaveLength(1); // only the leftover; never the ATOTW or the journal paper
  await prog.getByRole('button', { name: 'Close' }).click();

  // The old ATOTW: abstract from the PDF, labelled, plus journal and year.
  await page.goto(`/?emulator=${PROJECT}#/paper/a1`);
  await expect(page.getByText('Anaesthesia Tutorial of the Week · 2012')).toBeVisible();
  await page.getByText('Abstract', { exact: true }).click();
  await expect(page.getByText('Taken from the PDF’s own abstract or summary.')).toBeVisible();
  await expect(page.getByText('Sedation in the intensive care unit is given to relieve anxiety')).toBeVisible();
  // The journal PDF: the printed DOI was looked up (fixture), title replaced, abstract from PubMed/Crossref.
  await page.goto(`/?emulator=${PROJECT}#/paper/j1`);
  await expect(page.getByRole('heading', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Publisher page' })).toBeVisible();
  // Leftover: AI summary, labelled.
  await page.goto(`/?emulator=${PROJECT}#/paper/h1`);
  await page.getByText('AI summary', { exact: true }).click();
  await expect(page.getByText('Written by an AI from the PDF text, not by the authors.')).toBeVisible();
  await expect(page.getByText('A short neutral summary of this handout')).toBeVisible();
  // Untouched.
  await page.goto(`/?emulator=${PROJECT}#/paper/k1`);
  await page.getByText('Abstract', { exact: true }).click();
  await expect(page.getByText('Kept as it is.')).toBeVisible();
  await expect(page.getByText('AI summary', { exact: true })).toHaveCount(0);
});

test('any member edits details by hand; a later Refresh leaves those fields alone; the member can hand them back', async ({ browser }) => {
  test.setTimeout(90000);
  const mk = async (email, role) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await workerApi(page, PROJECT);
    const uid = await signIn(page, email, role);
    return { page, uid };
  };
  const mem = await mk('plain.member@example.org', 'member');
  const adm = await mk('admin.refresh@example.org', 'admin');
  await seed(adm.page, 'e1', { title: s('Alogliptin after ACS'), doi: s('10.1056/NEJMoa1305889'), journal: s('Old journal'), authors: arr(['Ann Author']),
    abstract: s('Old abstract'), file: undefined, addedBy: s('someone-else'), addedAt: at(T0) });

  // A member who did not add the paper edits it.
  await open(mem.page, 'paper/e1');
  await expect(mem.page.getByRole('heading', { name: 'Alogliptin after ACS' })).toBeVisible();
  await mem.page.getByRole('button', { name: 'Edit details' }).click();
  const sheet = mem.page.getByRole('dialog', { name: 'Edit details' });
  await sheet.getByLabel('Title').fill('Alogliptin after acute coronary syndrome (corrected by hand)');
  await sheet.getByLabel('Year').fill('2013');
  await sheet.getByLabel('Abstract').fill('Typed by a member.');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mem.page.getByRole('heading', { name: 'Alogliptin after acute coronary syndrome (corrected by hand)' })).toBeVisible();
  await expect(mem.page.getByText('Edited by hand (title, year, abstract)')).toBeVisible();
  expect(await mem.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Bad input is refused in the sheet.
  await mem.page.getByRole('button', { name: 'Edit details' }).click();
  await mem.page.getByRole('dialog', { name: 'Edit details' }).getByLabel('Year').fill('99');
  await mem.page.getByRole('dialog', { name: 'Edit details' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mem.page.getByText('The year must be between 1800 and 2100.')).toBeVisible();
  await mem.page.getByRole('dialog', { name: 'Edit details' }).getByRole('button', { name: 'Cancel' }).click();

  // The admin refreshes it: journal updates from the lookup; the typed fields stay.
  await open(adm.page);
  await adm.page.getByLabel('Search the library').fill('alogliptin');
  await expect(adm.page.locator('#res li')).toHaveCount(1);
  await adm.page.getByRole('button', { name: 'Select', exact: true }).click();
  await adm.page.getByRole('button', { name: 'All 1' }).click();
  await adm.page.getByRole('button', { name: 'Refresh 1' }).click();
  const prog = adm.page.getByRole('dialog', { name: 'Refreshing papers' });
  await expect(prog.getByRole('heading', { name: 'Done: 1 paper' })).toBeVisible({ timeout: 30000 });
  await prog.getByRole('button', { name: 'Close' }).click();
  await adm.page.goto(`/?emulator=${PROJECT}#/paper/e1`);
  await expect(adm.page.getByRole('heading', { name: 'Alogliptin after acute coronary syndrome (corrected by hand)' })).toBeVisible();
  await expect(adm.page.getByText(/Old journal/)).toHaveCount(0); // the journal was not typed by hand, so it was refreshed
  await adm.page.getByText('Abstract', { exact: true }).click();
  await expect(adm.page.getByText('Typed by a member.')).toBeVisible();
  await expect(adm.page.getByText('Old abstract')).toHaveCount(0);

  // Hand the fields back: Refresh now replaces the title and abstract.
  await open(mem.page, 'paper/e1');
  await mem.page.getByRole('button', { name: 'Let Refresh update these again' }).click();
  await expect(mem.page.getByText(/Edited by hand/)).toHaveCount(0);
  await open(adm.page);
  await adm.page.getByLabel('Search the library').fill('alogliptin');
  await expect(adm.page.locator('#res li')).toHaveCount(1);
  await adm.page.getByRole('button', { name: 'Select', exact: true }).click();
  await adm.page.getByRole('button', { name: 'All 1' }).click();
  await adm.page.getByRole('button', { name: 'Refresh 1' }).click();
  const again = adm.page.getByRole('dialog', { name: 'Refreshing papers' });
  await expect(again.getByRole('heading', { name: 'Done: 1 paper' })).toBeVisible({ timeout: 30000 });
  await again.getByRole('button', { name: 'Close' }).click();
  await adm.page.goto(`/?emulator=${PROJECT}#/paper/e1`);
  await expect(adm.page.getByRole('heading', { name: /^Alogliptin after acute coronary syndrome in patients/i })).toBeVisible();
  await expect(adm.page.getByText('corrected by hand')).toHaveCount(0);
});
