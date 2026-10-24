import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const DAY = 86400000;
const s = (v) => ({ stringValue: v });
const arr = (a) => ({ arrayValue: { values: a.map(s) } });
const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const put = async (page, path, fields) => { const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } }); expect(r.ok()).toBeTruthy(); };

// Every page a member or an admin can reach, at phone width: nothing logged to the console, no page error,
// no failed request except a sign-in-gated one, and no sideways scroll.
test.setTimeout(90000);

// A one-page PDF (valid xref so PDF.js reads it without repair).
function makePdf() {
  const stream = 'BT /F1 12 Tf 20 100 Td (Sweep page) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
test('every route at 390 px: no console errors, no failed requests, no sideways scroll', async ({ page }) => {
  const { files } = await workerApi(page, PROJECT);
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !/firestore|identitytoolkit|securetoken/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack}`));
  page.on('requestfailed', (r) => { if (!/firestore|google|identitytoolkit|securetoken/.test(r.url()) && r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`requestfailed: ${r.url()}`); });

  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('sweep@example.org'); return window.__jc.auth.currentUser.uid; });
  const now = Date.now();
  await put(page, `members/${uid}`, { email: s('sweep@example.org'), name: s('Sweep Admin'), role: s('admin'), inviteId: s('seed') });
  const long = 'Background: ' + 'A very long abstract sentence that keeps going. '.repeat(20) + 'Conclusions: It ends.';
  const paper = (title, extra = {}) => ({ title: s(title), journal: s('British Journal of Anaesthesia'), year: { integerValue: '2024' }, doi: s('10.1/x'),
    abstract: s(long), authors: arr(['Ann Author', 'Bo Writer']), tags: arr(['airway', 'trial']), addedBy: s(uid), addedAt: ts(now - 5 * DAY), changedAt: ts(now - 5 * DAY), ...extra });
  await put(page, 'papers/p1', paper('A deliberately long title about the comparative effectiveness of videolaryngoscopy versus direct laryngoscopy in adults'));
  await put(page, 'papers/p2', paper('No abstract paper', { abstract: s('') }));
  await put(page, 'papers/p3', paper('Pdf paper', { file: { mapValue: { fields: { pages: { integerValue: '3' } } } } }));
  files.set('papers/p3.pdf', makePdf());
  await put(page, 'sessions/s1', { date: ts(new Date(now - 3 * DAY).setHours(0, 0, 0, 0)), paperId: s('p1'), paperTitle: s('A deliberately long title'),
    presenterName: s('Pat Presenter'), summary: s(''), slides: s('') });
  await put(page, 'lists/l1', { name: s('Obstetric posting'), about: s('x'), paperIds: arr(['p1']), createdBy: s(uid), visibility: s('shared') });

  const hashes = ['', 'library', 'calendar', 'settings', 'lists', 'list/l1', 'list/starred-' + uid, 'home', 'sessions', 'session/s1', 'plan', 'add', 'import', 'paper/p1', 'paper/p2', 'paper/p3',
    'read/p3/1', 'remove/p1', 'reindex', 'duplicates', 'admin', 'me', 'join/nosuchtoken', 'nosuchroute'];
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  for (const h of hashes) {
    await page.goto(`/?emulator=${PROJECT}#/${h}`);
    await page.waitForTimeout(900);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 0) problems.push(`sideways scroll ${wide}px at #/${h}`);
    const text = await page.locator('#view').innerText().catch(() => '');
    if (/undefined|NaN|\[object/.test(text)) problems.push(`bad text at #/${h}: ${text.match(/.{0,30}(undefined|NaN|\[object).{0,30}/s)?.[0]}`);
  }
  expect(problems).toEqual([]);
});
