import { test, expect, PROJECT, DOCS } from './emu.js';
import { workerApi } from './worker-api.js';

// A phone in the owner's condition (Android Chrome at 390 px) whose Firestore streaming channel stalls: every read that
// needs it waits for the SDK's 10 s offline timeout. The app must still show the count and enable Select in seconds.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const at = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const T0 = Date.UTC(2026, 0, 1);

test('a stalled Firestore stream and a hung count: the count line and Select are ready in 6 s, and Copy diagnostics names the slow reads', async ({ page, context }) => {
  test.setTimeout(60000);
  await workerApi(page, PROJECT);
  await page.goto(`/?emulator=${PROJECT}#/library`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('stall@example.org'); return window.__jc.auth.currentUser.uid; });
  expect((await page.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: {
    email: s('stall@example.org'), name: s('Stall'), role: s('member'), inviteId: s('seed') } } })).ok()).toBeTruthy();
  for (const i of [1, 2, 3]) {
    expect((await page.request.patch(`${DOCS}/papers/st${i}`, { headers: owner, data: { fields: {
      title: s(`Stalled stream paper ${i}`), doi: s(''), pmid: s(''), abstract: s('abs'), authors: { arrayValue: { values: [s('A Author')] } }, journal: s('Anaesthesia'),
      tags: { arrayValue: {} }, addedBy: s(uid), addedAt: at(T0 + i * 1000), changedAt: at(T0 + i * 1000) } } })).ok()).toBeTruthy();
  }
  // A first visit on this phone: the sync stamp, saved head and member copy are stored on the device.
  await page.goto(`/?emulator=${PROJECT}#/library`);
  await page.reload();
  await expect(page.locator('#count')).toHaveText('3 papers · Recently discussed');

  // From now on the streaming channel never answers and the count never returns.
  await context.route(/Listen\/channel/, () => {});
  await page.route('**/*runAggregationQuery*', () => {});
  await page.goto('about:blank');
  const t0 = Date.now();
  await page.goto(`/?emulator=${PROJECT}#/library`, { waitUntil: 'commit' });
  await expect(page.locator('#selb')).toBeEnabled({ timeout: 6000 });
  await expect(page.locator('#count')).toHaveText(/^3\+? papers · Recently discussed$/);
  expect(Date.now() - t0).toBeLessThan(6000);
  await expect(page.locator('#res li')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The line a member pastes if it recurs: it carries the browser and the timings of the reads that stalled.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/?emulator=${PROJECT}#/me`, { waitUntil: 'commit' });
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  await expect(page.locator('#diagmsg')).toHaveText('Copied.');
  const line = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(line).toMatchObject({ sync: true, online: true, memberError: 'timeout' });
  expect(line.ua).toContain('Android');
});
