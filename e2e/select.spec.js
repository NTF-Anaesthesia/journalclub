import { test, expect, PROJECT, DOCS, BASE, pickFilter, filterCount } from './emu.js';
import { workerApi } from './worker-api.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const arr = (xs) => ({ arrayValue: { values: xs.map(s) } });
const at = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const T0 = Date.UTC(2026, 0, 1);

// The same one-page PDF as library.spec.js.
function makePdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const pos = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return pos; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function signIn(page, email, role = 'member') {
  await page.goto(`/?emulator=${PROJECT}#/library`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const r = await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s(email), name: s(email.split('@')[0]), role: s(role), inviteId: s('seed') } } });
  expect(r.ok()).toBeTruthy();
  return uid;
}
const seed = (page, id, fields) => page.request.patch(`${DOCS}/papers/${id}`, { headers: owner, data: { fields: {
  doi: s(''), pmid: s(''), abstract: s(''), authors: arr(['Ann Author']), journal: s('Anaesthesia'), tags: arr([]), ...fields } } })
  .then((r) => expect(r.ok()).toBeTruthy());
const open = async (page, hash = 'library') => { await page.goto(`/?emulator=${PROJECT}#/${hash}`); await page.reload(); };
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function longPress(page, locator) {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
}

test('admin: filter No abstract, long-press, All, Refresh touches only those; PDF not indexed + Reindex', async ({ page }) => {
  test.setTimeout(60000);
  const { files, calls } = await workerApi(page, PROJECT);
  const uid = await signIn(page, 'admin.sel@example.org', 'admin');
  await seed(page, 'n1', { title: s('Alogliptin'), doi: s('10.1056/NEJMoa1305889'), addedBy: s(uid), addedAt: at(T0 + 1000) });
  await seed(page, 'n2', { title: s('ATOTW 551 SGLT2'), addedBy: s(uid), addedAt: at(T0 + 2000) });
  await seed(page, 'n3', { title: s('ward round handout'), addedBy: s(uid), addedAt: at(T0 + 3000) });
  await seed(page, 'h1', { title: s('Has abstract already'), doi: s('10.1371/journal.pmed.0020124'), abstract: s('Kept as is'), addedBy: s(uid), addedAt: at(T0 + 4000) });
  await seed(page, 'f1', { title: s('Scanned PDF never indexed'), abstract: s('A PDF'), file: { mapValue: { fields: { pages: { integerValue: '1' } } } },
    addedBy: s(uid), addedAt: at(T0 + 5000) });
  files.set('papers/f1.pdf', makePdf('Quokkastatin halves nausea'));
  await open(page);

  await pickFilter(page, 'No abstract · 3');
  await expect(page.locator('#res li')).toHaveCount(3);
  await longPress(page, page.locator('#res li').first());
  await expect(page.locator('#scount')).toHaveText('1 selected');
  await expect(page.locator('#tabbar')).toBeHidden();
  await page.getByRole('button', { name: 'All 3' }).click();
  await expect(page.locator('#scount')).toHaveText('3 selected');
  await expect(page.getByText('All 3 matching papers selected.')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Refresh 2' }).click();
  const prog = page.getByRole('dialog', { name: 'Refreshing papers' });
  await expect(prog.getByRole('heading', { name: 'Done: 3 papers' })).toBeVisible({ timeout: 20000 });
  await expect(prog.locator('li', { hasText: 'Abstract added' })).toContainText(/[12]/);
  await expect(prog.locator('li', { hasText: 'Skipped, no ID' })).toContainText('1');
  expect(calls.filter((x) => x === 'GET /api/lookup')).toHaveLength(2); // never the paper that had an abstract
  // The ones still missing an abstract can be selected for a hand fix.
  await prog.getByRole('button', { name: /^Select the \d still missing$/ }).click();
  await expect(page.locator('#scount')).toHaveText(/^[12] selected$/);
  await expect(page.locator('#res li.picked', { hasText: 'ward round handout' })).toBeVisible();
  await page.getByRole('button', { name: '‹ Back' }).click();
  await expect(page.locator('#tabbar')).toBeVisible();
  await page.getByRole('button', { name: /^No abstract/ }).click(); // off again
  await expect(page.getByRole('link', { name: 'Has abstract already' })).toBeVisible();

  // PDF not indexed: a PDF with no pages in D1; Reindex reads it again and search finds its words.
  await pickFilter(page, 'PDF not indexed · 1');
  await expect(page.locator('#res li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'All 1' }).click();
  await page.getByRole('button', { name: 'Reindex 1' }).click();
  const re = page.getByRole('dialog', { name: 'Reindexing papers' });
  await expect(re.getByRole('heading', { name: 'Done: 1 paper' })).toBeVisible({ timeout: 20000 });
  await expect(re.locator('li', { hasText: 'Indexed' })).toContainText('1');
  await re.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'PDF not indexed · 0' })).toBeVisible();
  await page.getByRole('button', { name: '‹ Back' }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Search the library').fill('quokkastatin');
  await expect(page.locator('#res li .hit')).toHaveText('p. 1');
});

test('member: sort by year, star on one device and see it in Saved on another, filter starred, make a private list from the sheet, someone else\'s old shared list stays hidden, bulk tag with undo', async ({ browser }) => {
  test.setTimeout(60000);
  const a = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await workerApi(a, PROJECT);
  const uid = await signIn(a, 'res.sel@example.org');
  for (const [i, y] of [[1, 2001], [2, 2024], [3, 2012]]) {
    await seed(a, `y${i}`, { title: s(`Year paper ${y}`), year: { integerValue: String(y) }, abstract: s('abs'), addedBy: s('someone'), addedAt: at(T0 + 9000 + i) });
  }
  expect((await a.request.patch(`${DOCS}/lists/shared1`, { headers: owner, data: { fields: { name: s('Journal club picks'), about: s(''),
    paperIds: { arrayValue: {} }, createdBy: s('someone'), visibility: s('shared'), createdAt: at(T0) } } })).ok()).toBeTruthy();
  await open(a);

  await a.locator('#sortb').click();
  await a.getByRole('dialog', { name: 'Sort' }).getByRole('radio', { name: 'Year' }).click(); // the sheet closes on choosing
  await expect(a.locator('#count')).toContainText('· Year');
  await expect(a.locator('#res li').first()).toContainText('Year paper 2024');

  // Star on device A.
  await a.getByRole('link', { name: 'Year paper 2012' }).click();
  await a.getByRole('button', { name: 'Star', exact: true }).click();
  await expect(a.getByRole('button', { name: 'Starred' })).toHaveAttribute('aria-pressed', 'true');

  // Device B: the same member, its own browser storage.
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const b = await ctxB.newPage();
  await workerApi(b, PROJECT);
  await b.goto(`/?emulator=${PROJECT}#/library`);
  await b.evaluate(async () => { await window.__jc.signIn('res.sel@example.org'); });
  await open(b, 'lists');
  await expect(b.getByRole('link', { name: /Starred\s+· 1 paper/ })).toBeVisible();
  await expect(b.locator('#srecent')).toContainText('Year paper 2012');
  await b.getByRole('link', { name: /Starred/ }).click();
  await expect(b.getByRole('link', { name: 'Year paper 2012' })).toBeVisible();
  await open(b);
  await b.getByRole('button', { name: 'Starred · 1' }).click();
  await expect(b.locator('#res li')).toHaveCount(1);
  expect(await noSideScroll(b)).toBe(true);

  // Lists are private: someone else's old shared list is not offered; a new list is made from the sheet.
  await b.getByRole('link', { name: 'Year paper 2012' }).click();
  await b.getByRole('button', { name: 'Lists and tags…' }).click();
  const sheetB = b.getByRole('dialog', { name: 'Add 1 paper to' });
  await expect(sheetB.getByText('Journal club picks')).toHaveCount(0);
  await sheetB.getByLabel('Find or create a list or tag').fill('Exam prep');
  await sheetB.getByRole('button', { name: '+ New private list “Exam prep”' }).click();
  await expect(sheetB.getByRole('checkbox', { name: /Exam prep/ })).toBeChecked(); // the list exists before Save
  await sheetB.getByRole('button', { name: 'Save' }).click();
  await expect(b.getByText('In Starred, Exam prep')).toBeVisible();
  await open(b, 'lists');
  await expect(b.getByRole('heading', { name: 'Private lists' })).toBeVisible();
  await expect(b.getByRole('link', { name: /Exam prep/ })).toBeVisible();
  await expect(b.getByText('Journal club picks')).toHaveCount(0);

  // Bulk tag from select mode, then Undo.
  await open(a);
  await a.getByRole('button', { name: 'Select', exact: true }).click();
  await a.getByRole('button', { name: /^All \d+$/ }).click();
  await a.getByRole('button', { name: 'Add to…' }).click();
  const sheetA = a.getByRole('dialog', { name: /^Add \d+ papers to$/ });
  await sheetA.getByLabel('Find or create a list or tag').fill('exam');
  await sheetA.getByRole('button', { name: '+ New shared tag “exam”' }).click();
  await sheetA.getByRole('button', { name: 'Save' }).click();
  await expect(a.locator('.snack').getByRole('button', { name: 'Undo' })).toBeVisible();
  await filterCount(a, 'Untagged · 0');
  await a.locator('.snack').getByRole('button', { name: 'Undo' }).click();
  await filterCount(a, /^Untagged · [1-9]/);
  await ctxB.close();
  await a.close();
});

test('admin: Find duplicates merges two papers, keeping notes, ratings, PDF, lists and sessions', async ({ page }) => {
  test.setTimeout(60000);
  const { files } = await workerApi(page, PROJECT);
  const uid = await signIn(page, 'admin.sel@example.org', 'admin');
  const pdf = { file: { mapValue: { fields: { pages: { integerValue: '1' } } } } };
  await seed(page, 'dk', { title: s('Tranexamic acid in hip fracture surgery'), doi: s('10.9/TXA'), abstract: s('With abstract'), ...pdf, tags: arr(['ortho']), addedBy: s(uid), addedAt: at(T0 + 20000) });
  await seed(page, 'dd', { title: s('Tranexamic acid in hip-fracture surgery.'), doi: s('10.9/txa'), tags: arr(['exam']), addedBy: s('someone'), addedAt: at(T0 + 21000) });
  files.set('papers/dk.pdf', makePdf('kept'));
  const note = (id, who, text, rating) => a2(page.request.patch(`${DOCS}/papers/${id}/notes/${who}`, { headers: owner, data: { fields: {
    text: s(text), rating: { integerValue: String(rating) }, name: s(who), shared: { booleanValue: true }, updatedAt: at(T0) } } }));
  const a2 = (p) => p.then((r) => expect(r.ok()).toBeTruthy());
  await note('dd', 'm1', 'Good on dosing', 4);
  await note('dk', 'm1', 'Read it', 2);
  await note('dd', 'm2', 'Only on the copy', 5);
  await a2(page.request.patch(`${DOCS}/lists/l-dup`, { headers: owner, data: { fields: { name: s('Ortho'), about: s(''), paperIds: arr(['dd']),
    createdBy: s('someone'), visibility: s('private'), createdAt: at(T0) } } }));
  await a2(page.request.patch(`${DOCS}/sessions/s-dup`, { headers: owner, data: { fields: { date: at(T0), paperId: s('dd'), paperTitle: s('Tranexamic acid'),
    presenterUid: s(''), presenterName: s('P'), summary: s(''), slides: s(''), createdBy: s('someone'), createdAt: at(T0) } } }));
  await open(page, 'duplicates');
  await expect(page.getByRole('heading', { name: 'Same DOI' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Keep Tranexamic acid in hip fracture surgery' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Keep Tranexamic acid in hip-fracture surgery.' })).toBeDisabled(); // it has no PDF
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByText('No duplicates found.')).toBeVisible({ timeout: 15000 });
  const get = async (path) => (await page.request.get(`${DOCS}/${path}`, { headers: owner })).json();
  expect((await get('papers/dd')).error?.code).toBe(404);
  const kept = await get('papers/dk');
  expect(kept.fields.tags.arrayValue.values.map((v) => v.stringValue)).toEqual(['ortho', 'exam']);
  const m1 = await get('papers/dk/notes/m1'), m2 = await get('papers/dk/notes/m2');
  expect(m1.fields.text.stringValue).toBe('Read it\n\nGood on dosing');
  expect(m1.fields.rating.integerValue).toBe('4');
  expect(m2.fields.text.stringValue).toBe('Only on the copy');
  expect((await get('lists/l-dup')).fields.paperIds.arrayValue.values.map((v) => v.stringValue)).toEqual(['dk']);
  expect((await get('sessions/s-dup')).fields.paperId.stringValue).toBe('dk');
  expect(files.has('papers/dk.pdf')).toBe(true);
});

test('admin: opening Saved turns an old shared list into a shared tag and makes the list private to its maker', async ({ page }) => {
  await signIn(page, 'admin.tags@example.org', 'admin');
  await seed(page, 'sl1', { title: s('Epidural in labour'), tags: arr(['obstetric']), addedBy: s('someone'), addedAt: at(T0 + 30000) });
  await seed(page, 'sl2', { title: s('Spinal for caesarean'), addedBy: s('someone'), addedAt: at(T0 + 31000) });
  const a2 = (p) => p.then((r) => expect(r.ok()).toBeTruthy());
  await a2(page.request.patch(`${DOCS}/lists/old-shared`, { headers: owner, data: { fields: { name: s('Obstetric, posting'), about: s(''),
    paperIds: arr(['sl1', 'sl2']), createdBy: s('someone'), visibility: s('shared'), createdAt: at(T0) } } }));
  await open(page, 'lists');
  await expect(page.getByRole('heading', { name: 'Private lists' })).toBeVisible();
  const get = async (path) => (await page.request.get(`${DOCS}/${path}`, { headers: owner })).json();
  const tags = async (id) => ((await get(`papers/${id}`)).fields.tags?.arrayValue.values || []).map((v) => v.stringValue);
  await expect.poll(async () => (await get('lists/old-shared')).fields.visibility.stringValue).toBe('private');
  expect(await tags('sl1')).toEqual(['obstetric', 'obstetric posting']);
  expect(await tags('sl2')).toEqual(['obstetric posting']);
  expect((await get('lists/old-shared')).fields.createdBy.stringValue).toBe('someone');
});

test('a count that never returns does not hold the page: Select and long-press work and the count line fills in', async ({ page }) => {
  await signIn(page, 'slowcount@example.org');
  for (const i of [1, 2, 3]) await seed(page, `slow${i}`, { title: s(`Slow count paper ${i}`), addedAt: at(T0 + i * 1000), changedAt: at(T0 + i * 1000) });
  await open(page);
  await expect(page.locator('#count')).toHaveText(/\d+ papers · Recently discussed/); // sync point and head saved
  // From now on the count RPC hangs, as seen on a phone.
  await page.route('**/*runAggregationQuery*', () => {});
  await page.reload();
  await expect(page.locator('#selb')).toBeEnabled({ timeout: 6000 });
  await expect(page.locator('#count')).not.toHaveText(/Loading/);
  await expect(page.locator('#count')).toHaveText(/\d+\+? papers · Recently discussed/);
  await expect.poll(() => page.evaluate(() => window.__jcTiming.countError), { timeout: 8000 }).toBe('timeout');
  await longPress(page, page.locator('#res li').first());
  await expect(page.locator('#scount')).toHaveText('1 selected');
  await expect(page.locator('#selbar')).toBeVisible();
});
