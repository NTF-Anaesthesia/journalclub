import { test, expect, PROJECT, DOCS } from './emu.js';

test.use({ viewport: { width: 390, height: 844 } });

const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const pad = (n) => String(n).padStart(2, '0');

async function put(page, path, fields) {
  const r = await page.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } });
  expect(r.ok()).toBeTruthy();
}

test('opens on Club; whole cards open their page; Calendar shows the month, opens a session and plans on an empty day', async ({ page }) => {
  await page.goto(`/?emulator=${PROJECT}`);
  const uid = await page.evaluate(async () => { await window.__jc.signIn('cal@example.org'); return window.__jc.auth.currentUser.uid; });
  await put(page, `members/${uid}`, { email: s('cal@example.org'), name: s('Cal Member'), role: s('member'), inviteId: s('seed') });
  // A session on the 20th of next month at noon, so the test never depends on today's date.
  const now = new Date(), day = new Date(now.getFullYear(), now.getMonth() + 1, 20, 12);
  const month = `${day.getFullYear()}-${pad(day.getMonth() + 1)}`;
  await put(page, 'sessions/c1', { date: { timestampValue: day.toISOString() }, paperTitle: s('Calendar paper'), presenterName: s('Pat Presenter') });
  await page.reload();

  // The default page is Club, with five tabs.
  await expect(page.getByRole('heading', { name: 'Club', exact: true })).toBeVisible();
  await expect(page.locator('#tabs .app-tab')).toHaveText(['Club', 'Calendar', 'Library', 'Saved', 'Settings']);
  await expect(page.locator('#tabs [aria-current="page"]')).toHaveText('Club');

  // Tapping the next-session card away from its links opens the session page.
  const card = page.locator('p.next');
  const box = await card.boundingBox();
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 8);
  await expect(page.getByText('SESSION', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/session\/c1$/);

  // Calendar: next month has the session on the 20th, listed below; the cell opens it.
  await page.locator('#tabs').getByText('Calendar').click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await page.getByRole('link', { name: 'Next month' }).click();
  await expect(page).toHaveURL(new RegExp(`#/calendar/${month}$`));
  await expect(page.locator('#cal-list li')).toHaveCount(1);
  await expect(page.locator('#cal-list')).toContainText('Pat Presenter');
  await expect(page.locator('.cal-day.has-session')).toHaveText('20');
  await page.locator('.cal-day.has-session').click();
  await expect(page).toHaveURL(/#\/session\/c1$/);

  // The agenda card opens the session from anywhere on it.
  await page.goto(`/?emulator=${PROJECT}#/calendar/${month}`);
  const row = page.locator('#cal-list li.paper');
  const rb = await row.boundingBox();
  await page.mouse.click(rb.x + rb.width - 10, rb.y + rb.height / 2);
  await expect(page).toHaveURL(/#\/session\/c1$/);

  // An empty day plans a session on that date.
  await page.goto(`/?emulator=${PROJECT}#/calendar/${month}`);
  await page.getByRole('link', { name: /: plan a session$/ }).filter({ hasText: /^21$/ }).click();
  await expect(page.getByRole('heading', { name: 'Plan a session' })).toBeVisible();
  await expect(page.locator('#sdate')).toHaveValue(`${month}-21`);

  // An empty month says so; Settings holds the account.
  await page.goto(`/?emulator=${PROJECT}#/calendar/2001-01`);
  await expect(page.locator('#cal-list')).toHaveText('No sessions this month.');
  await page.locator('#tabs').getByText('Settings').click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('cal@example.org')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
