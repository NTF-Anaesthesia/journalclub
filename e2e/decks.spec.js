import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';

test.use({ viewport: { width: 390, height: 844 } });

// A one-page PDF whose text layer says `text` (valid xref, so PDF.js reads it without repair).
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
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });

test('a member adds a teaching deck; Slides lists it with session slides; one search finds slide text from either side and opens the slide', async ({ page }) => {
  test.setTimeout(60000);
  const { files } = await workerApi(page, PROJECT);
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('deck@example.org'); return window.__jc.auth.currentUser.uid; });
  expect((await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s('deck@example.org'), name: s('Dee Deck'), role: s('member'), inviteId: s('seed') } } })).ok()).toBeTruthy();
  // A past session with slides already on it (indexed when they were added).
  expect((await page.request.patch(`${DOCS}/sessions/ss1`, { headers: owner, data: { fields: {
    date: { timestampValue: new Date(Date.now() - 7 * 864e5).toISOString() }, paperTitle: s('Reversal agents'), presenterName: s('Pat'),
    slidesFile: { mapValue: { fields: { name: s('rev.pdf'), size: { integerValue: '10' }, kind: s('pdf'), pdf: { booleanValue: true } } } } } } })).ok()).toBeTruthy();
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();

  // Journals | Slides; Slides lists the session's slides.
  await expect(page.getByRole('link', { name: 'Journals' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Slides', exact: true }).click();
  await expect(page.locator('#sres li.slide-row')).toHaveCount(1);
  await expect(page.locator('#sres')).toContainText('Reversal agents');

  // Add a deck with a PDF: its page shows, the file is stored, its text is indexed.
  await page.getByRole('link', { name: 'Add a teaching deck' }).click();
  await page.getByLabel('Title').fill('Difficult airway');
  await expect(page.getByLabel('Presenter or author')).toHaveValue('Dee Deck');
  await page.getByLabel(/^Topics/).fill('Airway, ENT');
  await page.getByLabel(/Upload slides/).setInputFiles({ name: 'airway.pdf', mimeType: 'application/pdf', buffer: makePdf('Cricothyroidotomy scalpel bougie') });
  await page.getByRole('button', { name: 'Add deck' }).click();
  await expect(page.getByText('TEACHING SLIDES')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Difficult airway' })).toBeVisible();
  await expect(page.locator('.deckpage')).toContainText('airway.pdf');
  const did = page.url().split('#/deck/')[1];
  expect(files.has(`decks/${did}/pdf`)).toBeTruthy();

  // Slides side: a word only in the slide text finds the deck and shows the slide.
  await page.getByRole('link', { name: '← Slides' }).click();
  await expect(page.locator('#sres li.slide-row')).toHaveCount(2);
  await page.getByLabel('Search the library').fill('cricothyroidotomy');
  await expect(page.locator('#sres li.slide-row')).toHaveCount(1);
  await expect(page.locator('#sres')).toContainText('slide 1');
  // The same search on the Journals side shows the slide above the papers.
  await page.getByRole('link', { name: /Search papers for/ }).click();
  await expect(page.getByLabel('Search the library')).toHaveValue('cricothyroidotomy');
  await expect(page.locator('#sgroup li.slide-row')).toHaveCount(1);
  // A tap anywhere on the card opens the reader at that slide.
  const card = page.locator('#sgroup li.slide-row');
  const b = await card.boundingBox();
  await page.mouse.click(b.x + b.width - 10, b.y + 8);
  await expect(page).toHaveURL(new RegExp(`#/view/deck_${did}/1\\?q=cricothyroidotomy$`));
  await expect(page.locator('#rtitle')).toHaveText('Difficult airway');
  await expect(page.locator('.reader-pg canvas').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the deck' })).toBeVisible();

  // Metadata search finds by topic; the maker edits and deletes the deck; its file and index go with it.
  await page.goto(`/?emulator=${PROJECT}#/library/slides?q=ent`);
  await expect(page.locator('#sres')).toContainText('Difficult airway');
  await page.goto(`/?emulator=${PROJECT}#/deck/${did}/edit`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete deck' }).click();
  await expect(page.locator('#count')).toHaveText('Nothing found.'); // the box still says "ent"
  await page.getByLabel('Search the library').fill('');
  await expect(page.locator('#sres li.slide-row')).toHaveCount(1);
  expect(files.has(`decks/${did}/pdf`)).toBeFalsy();
});
