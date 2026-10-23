import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const REST = 'http://127.0.0.1:8080/v1/projects/demo-jc/databases/(default)/documents';
const owner = { Authorization: 'Bearer owner' };

async function signInAs(browser, email, name, role) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto('/?emulator');
  const uid = await page.evaluate(async (e) => { await window.__jc.signIn(e); return window.__jc.auth.currentUser.uid; }, email);
  const seed = await page.request.patch(`${REST}/members/${uid}`, { headers: owner, data: { fields: {
    email: { stringValue: email }, name: { stringValue: name }, role: { stringValue: role }, inviteId: { stringValue: 'seed' } } } });
  expect(seed.ok()).toBeTruthy();
  await page.reload();
  return page;
}

test('a member plans a session from a paper page; the paper and the list show it; vote and rota are gone', async ({ browser }) => {
  const admin = await signInAs(browser, 'chief@example.org', 'Chief Admin', 'admin');
  const res = await signInAs(browser, 'res@example.org', 'Ada Resident', 'member');
  for (const [id, title] of [['pa', 'Tranexamic acid in hip fracture'], ['pb', 'Sugammadex and pulmonary complications']]) {
    const r = await admin.request.patch(`${REST}/papers/${id}`, { headers: owner, data: { fields: {
      title: { stringValue: title }, year: { integerValue: '2024' }, tags: { arrayValue: {} }, addedBy: { stringValue: 'x' } } } });
    expect(r.ok()).toBeTruthy();
  }

  // Tabs are Library, Saved, Club: no Vote, no Sessions.
  await res.goto('/?emulator#/home');
  await expect(res.locator('#tabs').getByText('Vote')).toHaveCount(0);
  await expect(res.locator('#tabs').getByText('Saved')).toBeVisible();
  await expect(res.locator('#tabs .app-tab')).toHaveText(['Library', 'Saved', 'Club']);
  await res.goto('/?emulator#/rota');
  await expect(res.getByRole('heading', { name: 'Presenter rota' })).toHaveCount(0);

  // A member opens a paper and taps Plan a session: the paper is already chosen.
  await res.goto('/?emulator#/paper/pb');
  await expect(res.getByText('Not presented yet.')).toBeVisible();
  await res.getByRole('link', { name: 'Plan a session' }).click();
  await expect(res.getByLabel('Paper')).toHaveValue('Sugammadex and pulmonary complications');
  const day = new Date(Date.now() + 7 * 86400000);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await res.getByLabel('Date').fill(iso);
  await res.getByLabel('Coordinator').fill('Dr Consultant');
  await res.getByRole('button', { name: 'Plan session' }).click();
  await expect(res.getByText('Presenter: Ada Resident')).toBeVisible();
  await expect(res.getByText('Coordinator: Dr Consultant')).toBeVisible();

  // A presenter name that matches no member warns before saving (they could not edit the summary or slides).
  await res.getByRole('link', { name: 'Edit session' }).click();
  await res.getByLabel('Presenter').fill('Dr Nobody');
  await res.locator('#saveall').click();
  await expect(res.getByText(/Dr Nobody isn't linked to a member account/)).toBeVisible();
  await res.goBack();
  await expect(res.getByText('Presenter: Ada Resident')).toBeVisible();

  // The paper page shows the session; the library list shows the Presented badge.
  await res.goto('/?emulator#/paper/pb');
  await expect(res.locator('#jc').getByRole('link').first()).toBeVisible();
  await expect(res.locator('#jc').getByText('Presenter: Ada Resident')).toBeVisible();
  await res.goto('/?emulator#/library');
  const mon = day.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  await expect(res.locator('li.paper', { hasText: 'Sugammadex' }).getByText(`Presented ${mon}`)).toBeVisible();
  await expect(res.locator('li.paper', { hasText: 'Tranexamic' }).getByText(/Presented/)).toHaveCount(0);

  // Club shows the next session; the session page is read-only and the creator (a plain member) edits behind Edit session.
  await res.goto('/?emulator#/home');
  await expect(res.getByRole('heading', { name: 'Next session' })).toBeVisible();
  await expect(res.getByRole('link', { name: 'Add take-home point' })).toBeVisible();
  await res.locator('#nexts').click();
  const sid = res.url().split('/session/')[1];
  await expect(res.getByLabel('Summary')).toHaveCount(0);
  await expect(res.locator('#saveall')).toHaveCount(0);
  await res.getByRole('link', { name: 'Edit session' }).click();
  await expect(res.getByRole('heading', { name: 'Edit session' })).toBeVisible();
  await res.getByLabel('Summary').fill('Reversal choice and PPCs: no difference in the primary outcome.');
  await expect(res.locator('#pfmsg')).toHaveText('Unsaved changes');
  // Leaving with unsaved changes asks first; saying no keeps the page.
  res.once('dialog', (d) => d.dismiss());
  await res.locator('#savebar').getByRole('link', { name: 'Done' }).click();
  await expect(res.getByRole('heading', { name: 'Edit session' })).toBeVisible();
  // One Save (pinned above the tab bar) saves every section: no per-section save buttons.
  await expect(res.getByRole('button', { name: /^Save/ })).toHaveCount(1);
  await expect(res.locator('#saveall')).toBeInViewport();
  await res.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(res.locator('#pfmsg')).toHaveText('Saved.');

  // Slides: a PowerPoint upload (the Worker is faked here) shows Open PDF and Download PowerPoint.
  const sent = [];
  await res.route('**/api/slides/**', async (route) => {
    const r = route.request();
    sent.push(`${r.method()} ${r.headers()['x-file-name'] || ''}`);
    if (r.method() === 'PUT') return route.fulfill({ json: { name: 'Reversal talk.pptx', size: 2400000, kind: 'pptx', pdf: true } });
    if (r.method() === 'POST') return route.fulfill({ status: 422, json: { error: 'Could not pull the slides from that link. Share it as "Anyone with the link can view", or upload the file.' } });
    return route.fulfill({ json: { ok: true } });
  });
  await res.getByLabel('Or pull from a link').fill('https://docs.google.com/presentation/d/private/edit');
  await res.getByRole('button', { name: 'Add slides' }).click();
  await expect(res.locator('#smsg')).toContainText('Anyone with the link');
  await res.getByLabel('Or pull from a link').fill('');
  await res.getByLabel('Upload slides (PDF or PowerPoint)').setInputFiles({ name: 'Reversal talk.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from('PK') });
  await res.getByRole('button', { name: 'Add slides' }).click();
  await expect(res.locator('#scur')).toHaveText('Reversal talk.pptx · 2.3 MB');
  expect(sent).toEqual(['POST ', 'PUT Reversal%20talk.pptx']);
  await res.getByRole('link', { name: 'Done' }).click();
  await expect(res.locator('#ssum')).toHaveText('Reversal choice and PPCs: no difference in the primary outcome.');
  await expect(res.getByRole('button', { name: 'Open PDF' })).toBeVisible();
  await expect(res.getByRole('button', { name: 'Download PowerPoint' })).toBeVisible();
  await expect(res.locator('#sslides')).toContainText('Reversal talk.pptx · 2.3 MB');
  await res.getByRole('link', { name: 'Edit session' }).click();
  res.once('dialog', (d) => d.accept());
  await res.getByRole('button', { name: 'Remove slides' }).click();
  await expect(res.locator('#scur')).toHaveText('No slides yet.');

  // Another member sees no Edit button and can't open the Edit page; the creator can delete it and the badge goes.
  const other = await signInAs(browser, 'other@example.org', 'Olu Other', 'member');
  await other.goto('/?emulator#/session/' + sid);
  await expect(other.getByText('Presenter: Ada Resident')).toBeVisible();
  await expect(other.getByRole('link', { name: 'Edit session' })).toHaveCount(0);
  await other.goto('/?emulator#/plan/-/' + sid);
  await expect(other.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
  res.once('dialog', (d) => d.accept());
  await res.getByRole('button', { name: 'Delete session' }).click();
  await res.goto('/?emulator#/library');
  await expect(res.locator('li.paper', { hasText: 'Sugammadex' }).getByText(/Presented/)).toHaveCount(0);
});

test('admin edits the discussion form; presenter fills it; a member adds a point; the CSV has them', async ({ browser }) => {
  const admin = await signInAs(browser, 'chief2@example.org', 'Chief Two', 'admin');
  const pres = await signInAs(browser, 'pres2@example.org', 'Pat Presenter', 'member');
  const mem = await signInAs(browser, 'mem2@example.org', 'Mo Member', 'member');
  const presUid = await pres.evaluate(() => window.__jc.auth.currentUser.uid);
  const day = new Date(Date.now() + 3 * 86400000);
  const r = await admin.request.patch(`${REST}/sessions/disc1`, { headers: owner, data: { fields: {
    date: { timestampValue: new Date(day.setHours(0, 0, 0, 0)).toISOString() }, paperId: { stringValue: 'pz' },
    paperTitle: { stringValue: 'Dexmedetomidine delirium trial' }, presenterUid: { stringValue: presUid },
    presenterName: { stringValue: 'Pat Presenter' }, summary: { stringValue: '' }, slides: { stringValue: '' } } } });
  expect(r.ok()).toBeTruthy();

  // Admin adds a field to the default form and saves the Teams link.
  await admin.goto('/?emulator#/admin');
  await expect(admin.getByRole('heading', { name: 'Discussion form' })).toBeVisible();
  await expect(admin.getByLabel('Label').first()).toHaveValue('Take-home points');
  await admin.getByRole('button', { name: 'Add field' }).click();
  await admin.getByLabel('Label').last().fill('Local relevance');
  await admin.getByRole('button', { name: 'Save form' }).click();
  await expect(admin.getByText('Saved.')).toBeVisible();
  await admin.getByLabel('Standing Teams link').fill('https://teams.example.org/meet');
  await admin.getByRole('button', { name: 'Save meeting settings' }).click();
  await expect(admin.locator('#cmsg')).toHaveText('Saved.');

  // Admin sets the coordinator on the session's Edit page.
  await admin.goto('/?emulator#/plan/-/disc1');
  await admin.getByLabel('Coordinator').fill('Dr Consultant');
  await admin.locator('#saveall').click();
  await expect(admin.locator('#pfmsg')).toHaveText('Saved.');
  await admin.getByRole('link', { name: 'Done' }).click();
  await expect(admin.getByText('Coordinator: Dr Consultant')).toBeVisible();

  // The presenter fills in the new form.
  await pres.goto('/?emulator#/session/disc1');
  await pres.getByRole('link', { name: 'Edit session' }).click();
  await expect(pres.getByLabel('Local relevance')).toBeVisible();
  await pres.getByLabel('Take-home points').fill('Fewer delirium days\nMore bradycardia');
  await pres.getByLabel('Would this change our practice?').selectOption('Maybe');
  await pres.getByLabel('Local relevance').fill('Ward patients only');
  await pres.locator('#saveall').click();
  await expect(pres.locator('#pfmsg')).toHaveText('Saved.');
  await pres.getByRole('link', { name: 'Done' }).click();
  await expect(pres.getByRole('heading', { name: 'Local relevance' })).toBeVisible();
  await expect(pres.getByText('Ward patients only').first()).toBeVisible();

  // A member adds one point and edits it.
  await mem.goto('/?emulator#/session/disc1');
  await mem.getByRole('link', { name: 'Add your point' }).click();
  await mem.getByLabel('Your take-home point').fill('Watch the heart rate');
  await mem.getByRole('button', { name: 'Save' }).click();
  await expect(mem.locator('#pmsg')).toContainText('Saved');
  await mem.goto('/?emulator#/session/disc1');
  await expect(mem.getByText('Watch the heart rate')).toBeVisible();
  // Members can't edit the discussion or set the coordinator.
  await expect(mem.locator('#saveall')).toHaveCount(0);
  await expect(mem.getByLabel('Coordinator')).toHaveCount(0);

  // The CSV export has the filled session.
  await admin.goto('/?emulator#/sessions');
  const [dl] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  expect(csv).toContain('Local relevance');
  expect(csv).toContain('Dexmedetomidine delirium trial,Pat Presenter,Dr Consultant');
  expect(csv).toContain('Fewer delirium days | More bradycardia');
  expect(csv).toContain('Ward patients only');
  expect(csv).toContain('Watch the heart rate');

  // After the discussion is saved, the admin's form for this session still takes effect (it used to be ignored).
  await admin.goto('/?emulator#/plan/-/disc1');
  await admin.getByText('Discussion form for this session only').click();
  const local = admin.locator('#aform li', { has: admin.locator('input[value="Local relevance"]') });
  await local.getByLabel('Label').fill('Relevance to our unit');
  await admin.getByRole('button', { name: 'Save for this session' }).click();
  await expect(admin.locator('#dfields').getByLabel('Relevance to our unit')).toHaveValue('Ward patients only');
  await admin.getByRole('link', { name: 'Done' }).click();
  await expect(admin.getByRole('heading', { name: 'Relevance to our unit' })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Local relevance' })).toHaveCount(0);

  // "Use the default form" switches the session back to the default (Local relevance).
  await admin.getByRole('link', { name: 'Edit session' }).click();
  await admin.getByRole('button', { name: 'Use the default form' }).click();
  await expect(admin.locator('#dfields').getByLabel('Local relevance')).toHaveValue('Ward patients only');
});
