import { test, expect } from '@playwright/test';
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
  await page.goto('/?emulator');
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(
    `http://127.0.0.1:8080/v1/projects/demo-jc/databases/(default)/documents/members/${uid}`,
    { headers: { Authorization: 'Bearer owner' }, data: { fields: {
      email: { stringValue: email }, name: { stringValue: 'Res One' }, role: { stringValue: 'member' }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  return uid;
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('add by DOI, upload own PDF, search notes and PDF text, open at the page, reading list', async ({ page }) => {
  const { files } = await workerApi(page);
  await signInAsMember(page, 'res1@example.org');
  await page.goto('/?emulator#/');
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
  await page.goto('/?emulator#/add');
  await page.getByLabel('DOI or PubMed ID').fill('10.1371/journal.pmed.0020124');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText('Already in the library:')).toBeVisible();
  await page.getByRole('link', { name: 'Why Most Published Research Findings Are False' }).click();

  // Upload (no licence step); PDF.js pulls out the text.
  await page.getByLabel('PDF file').setInputFiles({ name: 'talk.pdf', mimeType: 'application/pdf', buffer: makePdf('Sugammadex reverses rocuronium quickly') });
  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
  expect(files.size).toBe(1);

  // A note and rating.
  await page.getByLabel('Your note').fill('Bayesian framing of positive predictive value');
  await page.getByLabel('Your rating').selectOption('4');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('4.0/5 from 1')).toBeVisible();

  // Search: PDF text (with a typo), tags and notes.
  await page.getByRole('link', { name: 'Search', exact: true }).click();
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
  // Record where the new tab is sent (headless browsers treat a PDF tab as a download, so its URL isn't observable).
  await page.evaluate(() => {
    window.__opened = [];
    window.open = () => { const w = { location: {}, close() {} }; window.__opened.push(w); return w; };
  });
  await page.getByRole('button', { name: 'Open PDF at page 1' }).click();
  await expect.poll(() => page.evaluate(() => window.__opened[0]?.location.href || '')).toMatch(/^blob:.*#page=1$/);

  // Reading list.
  await page.getByRole('link', { name: 'Lists', exact: true }).click();
  await page.getByLabel('Name').fill('Research methods');
  await page.getByRole('button', { name: 'Create list' }).click();
  await expect(page.getByRole('heading', { name: 'Research methods' })).toBeVisible();
  await page.goto('/?emulator#/library');
  await page.getByRole('link', { name: 'Why Most Published Research Findings Are False' }).click();
  await page.getByRole('button', { name: 'Add to list' }).click();
  await expect(page.getByRole('heading', { name: 'Research methods' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Why Most Published Research Findings Are False' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});

test('bulk import reads DOIs from the PDFs, names the rest from the file, skips repeats', async ({ page }) => {
  const { files } = await workerApi(page);
  await signInAsMember(page, 'res2@example.org');
  await page.goto('/?emulator#/');
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
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search the library').fill('ketamine');
  await expect(page.getByRole('link', { name: 'ward round handout' })).toBeVisible();
  await page.getByRole('link', { name: 'ward round handout' }).click();
  await expect(page.getByRole('button', { name: 'Open PDF' })).toBeVisible();
  await expect(page.getByText(/Creative Commons|licence/i)).toHaveCount(0);
});

test('paper page decodes stored entities and bolds abstract section labels', async ({ page }) => {
  const uid = await signInAsMember(page, 'res2@example.org');
  // Stored the old way: hex entities left raw, labels as plain "LABEL: " text.
  const abstract = 'BACKGROUND: Low SpO&#x2082;&#xa0;is common.\nMETHODS: Adults with BMI &#x2264; 35. RESULTS: It fell.';
  const seed = await page.request.patch(
    'http://127.0.0.1:8080/v1/projects/demo-jc/databases/(default)/documents/papers/abs1',
    { headers: { Authorization: 'Bearer owner' }, data: { fields: {
      title: { stringValue: 'Oxygen in recovery' }, doi: { stringValue: '' }, pmid: { stringValue: '' },
      abstract: { stringValue: abstract }, addedBy: { stringValue: uid } } } });
  expect(seed.ok()).toBeTruthy();
  await page.goto('/?emulator#/paper/abs1');
  await page.reload();
  await page.getByText('Abstract', { exact: true }).click();
  const box = page.locator('.abstract');
  await expect(box.locator('strong')).toHaveText(['BACKGROUND:', 'METHODS:', 'RESULTS:']);
  await expect(box.locator('p')).toHaveCount(3);
  await expect(box).toContainText('SpO₂');
  await expect(box).toContainText('≤ 35');
  expect(await box.innerHTML()).not.toMatch(/&amp;#x|&#x/);
});
