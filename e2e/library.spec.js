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

async function signInAsMember(page, email) {
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(
    `${DOCS}/members/${uid}`,
    { headers: { Authorization: 'Bearer owner' }, data: { fields: {
      email: { stringValue: email }, name: { stringValue: 'Res One' }, role: { stringValue: 'member' }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  return uid;
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('add by DOI, upload own PDF, search notes and PDF text, open at the page, reading list', async ({ page }) => {
  const { files } = await workerApi(page, PROJECT);
  await signInAsMember(page, 'res1@example.org');
  await page.goto(`/?emulator=${PROJECT}#/`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

  // Add by DOI link.
  await page.getByRole('link', { name: 'Add a paper' }).click();
  await page.getByLabel('DOI or PubMed ID').fill('https://doi.org/10.1371/journal.pmed.0020124');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByRole('heading', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  await page.getByLabel('Tags, comma separated').fill('Statistics, critical appraisal');
  await page.getByLabel('Why read it (one line)').fill('Classic on bias');
  expect(await noSideScroll(page)).toBe(true);
  await page.getByRole('button', { name: 'Save to library' }).click();
  await expect(page.getByRole('heading', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Via NUS Libraries' })).toHaveAttribute('href', /libproxy1\.nus\.edu\.sg.*10\.1371/);

  // The same DOI again is caught.
  await page.goto(`/?emulator=${PROJECT}#/add`);
  await page.getByLabel('DOI or PubMed ID').fill('10.1371/journal.pmed.0020124');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText('Already in the library:')).toBeVisible();
  await page.getByRole('link', { name: 'Why Most Published Research Findings Are False' }).click();

  // Upload (no licence step); PDF.js pulls out the text.
  await page.getByLabel('PDF file').setInputFiles({ name: 'talk.pdf', mimeType: 'application/pdf', buffer: makePdf('Sugammadex reverses rocuronium quickly') });
  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
  expect(files.size).toBe(1);

  // A note.
  await page.getByLabel('Your note').fill('Bayesian framing of positive predictive value');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('#notes').getByText('Bayesian framing of positive predictive value')).toBeVisible();

  // Search: PDF text (with a typo), tags and notes.
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByLabel('Search the library').fill('sugammadex');
  await expect(page.getByText('p. 1')).toBeVisible();
  await expect(page.locator('.snippet mark')).toHaveText('Sugammadex');
  await page.getByLabel('Search the library').fill('bayesian');
  await expect(page.getByRole('link', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  await page.getByLabel('Search the library').fill('statistics');
  await expect(page.getByText('1 found')).toBeVisible();
  await page.getByLabel('Search the library').fill('rocuronium');
  expect(await noSideScroll(page)).toBe(true);
  await page.getByRole('link', { name: 'Why Most Published Research Findings Are False' }).click();
  // A PDF hit lands in the in-app reader at the page, not in a new tab.
  await expect(page).toHaveURL(/#\/read\/.*\/1\?q=rocuronium$/);
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  await page.getByRole('link', { name: 'Back to paper' }).click();
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();

  // Reading list.
  await page.getByRole('link', { name: 'Saved', exact: true }).click();
  await page.getByLabel('Name').fill('Research methods');
  await page.getByRole('button', { name: 'Create list' }).click();
  await expect(page.getByRole('heading', { name: 'Research methods' })).toBeVisible();
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.getByLabel('Search the library').fill(''); // same page as before: the search box still holds the last search
  await page.getByRole('link', { name: 'Why Most Published Research Findings Are False' }).click();
  await page.getByRole('button', { name: 'Lists and tags…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add 1 paper to' });
  await sheet.getByRole('checkbox', { name: /Research methods/ }).check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('In Research methods')).toBeVisible();
  await page.getByRole('link', { name: 'Saved', exact: true }).click();
  await page.getByRole('link', { name: /Research methods/ }).click();
  await expect(page.getByRole('heading', { name: 'Research methods' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});

test('bulk import reads DOIs from the PDFs, names the rest from the file, skips repeats', async ({ page }) => {
  const { files } = await workerApi(page, PROJECT);
  await signInAsMember(page, 'res2@example.org');
  await page.goto(`/?emulator=${PROJECT}#/`);
  await page.reload();
  await page.getByRole('link', { name: 'Import PDFs' }).click();
  const pdfs = [
    { name: 'alogliptin.pdf', mimeType: 'application/pdf', buffer: makePdf('N Engl J Med 2013. doi: 10.1056/NEJMoa1305889.') },
    { name: 'ward_round_handout.pdf', mimeType: 'application/pdf', buffer: makePdf('Ketamine dosing for the ward round') },
  ];
  await page.getByLabel('PDF files').setInputFiles(pdfs);
  await page.getByLabel('Tags for all, comma separated').fill('imported');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Done: 2 added, 0 already there, 0 failed.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Alogliptin after Acute Coronary Syndrome/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ward round handout' })).toBeVisible();
  expect(files.size).toBe(2);
  expect(await noSideScroll(page)).toBe(true);

  // Importing the same files again adds nothing.
  await page.getByLabel('PDF files').setInputFiles(pdfs);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Done: 0 added, 2 already there, 0 failed.')).toBeVisible();

  // Both are searchable by their PDF text, with no licence wording anywhere.
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await page.getByLabel('Search the library').fill('ketamine');
  await expect(page.getByRole('link', { name: 'ward round handout' })).toBeVisible();
  await page.getByRole('link', { name: 'ward round handout' }).click();
  await expect(page).toHaveURL(/#\/read\/.*\/1\?q=ketamine$/); // a PDF hit opens the reader
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  await expect(page.getByText(/Creative Commons|licence/i)).toHaveCount(0);
});

test('ATOTW PDFs with no printed DOI are found by the number in the file name or on the page', async ({ page }) => {
  await workerApi(page, PROJECT);
  await signInAsMember(page, 'res3@example.org');
  await page.goto(`/?emulator=${PROJECT}#/`);
  await page.reload();
  await page.getByRole('link', { name: 'Import PDFs' }).click();
  await page.getByLabel('PDF files').setInputFiles([
    { name: 'ATOTW 551 SGLT2.pdf', mimeType: 'application/pdf', buffer: makePdf('SGLT2 inhibitors and euglycaemic ketoacidosis') },
  ]);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Done: 1 added, 0 already there, 0 failed.')).toBeVisible();
  await page.getByRole('link', { name: 'SGLT-2 Receptor Inhibitors: Pharmacology and Anaesthetic Implications' }).click();
  await expect(page.getByText('Anaesthesia Tutorial of the Week')).toBeVisible();
  await page.getByText('Abstract', { exact: true }).click();
  await expect(page.locator('.abstract')).toContainText('This tutorial provides an overview');
  await expect(page.locator('.abstract')).not.toContainText('jats');
});

test('paper page decodes stored entities in the title and abstract, and bolds section labels', async ({ page }) => {
  const uid = await signInAsMember(page, 'res2@example.org');
  // Stored the old way: hex entities left raw, labels as plain "LABEL: " text.
  const abstract = 'BACKGROUND: Low SpO&#x2082;&#xa0;is common.\nMETHODS: Adults with BMI &#x2264; 35. RESULTS: It fell.';
  const seed = await page.request.patch(
    `${DOCS}/papers/abs1`,
    { headers: { Authorization: 'Bearer owner' }, data: { fields: {
      title: { stringValue: 'CO&#x2082; in recovery' }, doi: { stringValue: '' }, pmid: { stringValue: '' },
      abstract: { stringValue: abstract }, addedBy: { stringValue: uid } } } });
  expect(seed.ok()).toBeTruthy();
  await page.goto(`/?emulator=${PROJECT}#/paper/abs1`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'CO₂ in recovery' })).toBeVisible();
  await page.getByText('Abstract', { exact: true }).click();
  const box = page.locator('.abstract');
  await expect(box.locator('strong')).toHaveText(['BACKGROUND:', 'METHODS:', 'RESULTS:']);
  await expect(box.locator('p')).toHaveCount(3);
  await expect(box).toContainText('SpO₂');
  await expect(box).toContainText('≤ 35');
  expect(await box.innerHTML()).not.toMatch(/&amp;#x|&#x/);
});

test('admin "Refresh abstracts" updates an old-style paper and an ATOTW-named paper, and leaves tags alone', async ({ page }) => {
  await workerApi(page, PROJECT);
  const uid = await signInAsMember(page, 'res4@example.org');
  const api = DOCS;
  const headers = { Authorization: 'Bearer owner' };
  const s = (v) => ({ stringValue: v });
  expect((await page.request.patch(`${api}/members/${uid}`, { headers, data: { fields: {
    email: s('res4@example.org'), name: s('Res Four'), role: s('admin'), inviteId: s('seed') } } })).ok()).toBeTruthy();
  const seed = (id, fields) => page.request.patch(`${api}/papers/${id}`, { headers, data: { fields: {
    pmid: s(''), abstract: s(''), addedBy: s(uid), tags: { arrayValue: { values: [s('keep')] } }, ...fields } } });
  expect((await seed('old1', { title: s('Alogliptin'), doi: s('10.1056/NEJMoa1305889'), abstract: s('Platelets 109/L') })).ok()).toBeTruthy();
  expect((await seed('atotw1', { title: s('ATOTW 551 SGLT2'), doi: s('') })).ok()).toBeTruthy();
  expect((await seed('none1', { title: s('ward round handout'), doi: s('') })).ok()).toBeTruthy();
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();
  // Refresh lives in select mode: tick the three papers; the button counts only those with an ID.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  // Other specs share this emulator project, so rows are picked by paper id.
  for (const id of ['old1', 'atotw1', 'none1']) await page.locator(`#res li[data-id="${id}"]`).click();
  await expect(page.locator('#scount')).toHaveText('3 selected');
  await page.getByRole('button', { name: 'Refresh 2' }).click();
  const prog = page.getByRole('dialog', { name: 'Refreshing papers' });
  await expect(prog.getByRole('heading', { name: 'Done: 3 papers' })).toBeVisible({ timeout: 20000 });
  await expect(prog.locator('li', { hasText: 'Skipped, no ID' })).toContainText('1');
  await prog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: '‹ Back' }).click();
  await expect(page.locator('a[href="#/paper/atotw1"]')).toHaveText('SGLT-2 Receptor Inhibitors: Pharmacology and Anaesthetic Implications');
  await expect(page.locator('a[href="#/paper/old1"]')).toHaveText(/Alogliptin after Acute Coronary Syndrome/);
  await page.locator('a[href="#/paper/old1"]').click();
  await expect(page.locator('.tag', { hasText: /^keep$/ }).first()).toBeVisible();
  // A second run finds nothing to change.
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();
  await expect(page.locator('#count')).toContainText('papers · Recently discussed');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const id of ['old1', 'atotw1']) await page.locator(`#res li[data-id="${id}"]`).click();
  await page.getByRole('button', { name: 'Refresh 2' }).click();
  await expect(prog.getByRole('heading', { name: 'Done: 2 papers' })).toBeVisible({ timeout: 20000 });
  await expect(prog.locator('li', { hasText: 'Already up to date' })).toContainText('2');
});
