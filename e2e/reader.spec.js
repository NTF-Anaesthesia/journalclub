import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';
import { indexPages } from '../worker/search.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const arr = (a) => ({ arrayValue: { values: a.map(s) } });
const ID = 'rd1';
const TEXTS = ['Opening page about airway anatomy', 'Second page on induction agents', 'Third page: sugammadex reverses rocuronium quickly'];

// A multi-page PDF, one line of text per page (valid xref so PDF.js reads it without repair).
function makePdf(texts, pad = 0) {
  const n = texts.length;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  texts.forEach((t, i) => {
    const stream = `BT /F1 14 Tf 20 150 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  if (pad) objs.push(`<< /Length ${pad} >>\nstream\n${'0'.repeat(pad)}\nendstream`); // unreferenced bulk after the pages
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let files;
async function setup(page) {
  let db;
  ({ files, db } = await workerApi(page, PROJECT));
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('rd@example.org'); return window.__jc.auth.currentUser.uid; });
  for (const [path, fields] of [
    [`members/${uid}`, { email: s('rd@example.org'), name: s('Reader One'), role: s('member'), inviteId: s('seed') }],
    [`papers/${ID}`, { title: s('Reversal of neuromuscular block'), doi: s(''), pmid: s(''), abstract: s(''), authors: arr(['Ann Author']),
      journal: s('Anaesthesia'), tags: arr([]), addedBy: s(uid), file: { mapValue: { fields: { pages: { integerValue: '3' } } } } }]]) {
    const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } });
    expect(r.ok()).toBeTruthy();
  }
  files.set(`papers/${ID}.pdf`, makePdf(TEXTS));
  await indexPages(db, ID, TEXTS);
  await page.goto(`/?emulator=${PROJECT}#/`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  return uid;
}

const cacheKeys = (page) => page.evaluate(async () => (await (await caches.open('jc-offline-pdfs')).keys()).length);

test('a search hit opens the reader at the right page with the word marked; reopening resumes; pages scroll and zoom', async ({ page }) => {
  await setup(page);
  await page.getByLabel('Search the library').fill('sugammadex');
  await expect(page.getByText('p. 3')).toBeVisible();
  await page.getByRole('link', { name: 'Reversal of neuromuscular block' }).click();
  await expect(page).toHaveURL(/#\/read\/rd1\/3\?q=sugammadex$/);
  const reader = page.locator('.reader');
  await expect(reader).toHaveAttribute('data-ready', '1');
  await expect(page.getByLabel('Page number')).toHaveValue('3');
  await expect(page.locator('.reader-pg[data-n="3"] canvas')).toBeVisible();
  await expect(page.locator('.reader-pg[data-n="3"] .pdf-hl').first()).toBeVisible();
  expect(await page.locator('.reader-pg[data-n="3"]').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'Back to paper' })).toBeVisible();

  // Page jump, then scroll position is remembered for this member.
  await page.getByLabel('Page number').fill('2');
  await page.getByLabel('Page number').press('Enter');
  await expect(page.locator('.reader-pg[data-n="2"] canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('jc.read.')) || 'x') || '{}').rd1)).toBe(2);
  await page.goto(`/?emulator=${PROJECT}#/read/rd1`);
  await page.reload();
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await expect(page.locator('.reader-pg[data-n="2"] canvas')).toBeVisible();

  // Zoom in redraws at a bigger size.
  const w0 = (await page.locator('.reader-pg[data-n="2"]').boundingBox()).width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await page.locator('.reader-pg[data-n="2"]').boundingBox()).width).toBeGreaterThan(w0 * 1.2);
  await expect(page.locator('.reader-pg[data-n="2"] canvas')).toBeVisible();

  // Back to the paper page; Open PDF goes to the reader, not a new tab.
  await page.getByRole('link', { name: 'Back to paper' }).click();
  await expect(page.getByRole('heading', { name: 'Reversal of neuromuscular block' })).toBeVisible();
  await page.getByRole('button', { name: 'Open PDF' }).click();
  await expect(page).toHaveURL(/#\/read\/rd1$/);
});

test('airplane mode: the shell loads and a starred PDF opens from the offline copy; sign-out clears it', async ({ page, context }) => {
  await setup(page);
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active)).toBe(true);
  await page.getByRole('link', { name: 'Reversal of neuromuscular block' }).click();
  await page.getByRole('button', { name: 'Star', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starred' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cacheKeys(page)).toBe(1); // the starred PDF was saved
  await page.reload(); // controlled by the Service Worker from here on
  await expect(page.getByRole('heading', { name: 'Reversal of neuromuscular block' })).toBeVisible();
  await expect(page.getByText('Offline copy')).toBeVisible();
  // Let the worker finish caching what the page loaded.
  await page.waitForTimeout(1500);

  await context.setOffline(true);
  await page.goto(`/?emulator=${PROJECT}#/read/rd1/3`);
  await page.reload();
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('.reader-pg[data-n="3"] canvas')).toBeVisible();
  await expect(page.getByText('Offline copy')).toBeVisible();
  await context.setOffline(false);

  // In the library the Offline label sits on the PDF pill's line.
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await expect(page.locator('#res li.paper .pills .pdf-pill + .offline-badge')).toHaveText('Offline');

  // Settings shows the space, and sign-out empties the cache.
  await page.goto(`/?emulator=${PROJECT}#/me`);
  await expect(page.getByText(/1 paper saved on this device/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear offline papers' }).click();
  await expect(page.getByText(/No papers saved on this device/)).toBeVisible();
  expect(await cacheKeys(page)).toBe(0);
  await page.goto(`/?emulator=${PROJECT}#/read/rd1`);
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  await expect.poll(() => cacheKeys(page)).toBe(1); // opening a PDF keeps it
  await page.goto(`/?emulator=${PROJECT}#/me`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => cacheKeys(page)).toBe(0);
});

test('a large PDF opens on page 1 from Range chunks, before the whole file has downloaded', async ({ page }) => {
  await setup(page);
  const big = makePdf(TEXTS, 6 * 1024 * 1024);
  files.set(`papers/${ID}.pdf`, big);
  const ranges = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname !== `/api/file/${ID}` || r.status() !== 206) return;
    const m = /^bytes (\d+)-(\d+)\//.exec(r.headers()['content-range'] || '');
    if (m) ranges.push(Number(m[2]) - Number(m[1]) + 1);
  });
  await page.goto(`/?emulator=${PROJECT}#/read/${ID}/1`);
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('.reader-pg canvas').first()).toBeVisible();
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.reduce((a, b) => a + b, 0)).toBeLessThan(big.length / 2);
});

test('Download saves the PDF under the paper title; Send shares the file where the browser can', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__shared = null;
    navigator.canShare = (d) => !!d?.files?.length;
    navigator.share = async (d) => { window.__shared = { name: d.files?.[0]?.name, type: d.files?.[0]?.type, size: d.files?.[0]?.size, title: d.title }; };
  });
  await page.goto(`/?emulator=${PROJECT}#/read/${ID}`);
  await expect(page.locator('.reader')).toHaveAttribute('data-ready', '1');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  expect(dl.suggestedFilename()).toBe('Reversal of neuromuscular block.pdf');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual({
    name: 'Reversal of neuromuscular block.pdf', type: 'application/pdf', size: files.get(`papers/${ID}.pdf`).length, title: 'Reversal of neuromuscular block' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
