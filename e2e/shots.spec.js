// Look check, not part of the suite (run with SHOTS=1): the same screens from two builds side by side.
// SHOTS_BASE (the old build) and baseURL (this build) share one emulator project, so both show the same data.
import { mkdirSync } from 'node:fs';
import { test, expect, PROJECT, DOCS } from './emu.js';

const OUT = process.env.SHOTS_OUT || 'shots';
const BASE = process.env.SHOTS_BASE || 'http://localhost:5001';
const owner = { Authorization: 'Bearer owner' };
const s = (v) => ({ stringValue: v });
const SCREENS = ['home', 'calendar/2026-11', 'library', 'library/slides', 'paper/pa', 'saved', 'settings', 'admin', 'plan', 'import'];

test.skip(!process.env.SHOTS, 'look check only');
test.setTimeout(600000);

test('screens', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:5000/?emulator=${PROJECT}`);
  const uid = await p.evaluate(async () => { await window.__jc.signIn('chief@example.org'); return window.__jc.auth.currentUser.uid; });
  const put = async (path, fields) => expect((await p.request.patch(`${DOCS}/${path}`, { headers: owner, data: { fields } })).ok()).toBeTruthy();
  await put(`members/${uid}`, { email: s('chief@example.org'), name: s('Chief Admin'), role: s('admin'), inviteId: s('seed') });
  const when = '2026-10-01T00:00:00Z';
  await put('papers/pa', { title: s('Tranexamic acid in hip fracture surgery'), authors: { arrayValue: { values: [s('Lee A'), s('Tan B')] } },
    journal: s('Anaesthesia'), year: { integerValue: '2024' }, doi: s('10.1000/demo.1'), abstract: s('A made-up abstract for the look check.'),
    tags: { arrayValue: { values: [s('orthopaedics'), s('bleeding')] } }, why: s('Practice changing'), addedBy: s(uid), changedAt: { timestampValue: when },
    presented: { arrayValue: { values: [{ mapValue: { fields: { sid: s('ss1'), date: { timestampValue: '2026-11-12T04:00:00Z' } } } }] } } });
  await put('papers/pb', { title: s('Sugammadex and pulmonary complications'), journal: s('BJA'), year: { integerValue: '2023' },
    tags: { arrayValue: {} }, addedBy: s('x'), changedAt: { timestampValue: when } });
  await put('sessions/ss1', { date: { timestampValue: '2026-11-12T04:00:00Z' }, paperId: s('pa'), paperTitle: s('Tranexamic acid in hip fracture surgery'),
    presenterName: s('Chief Admin'), createdBy: s(uid) });
  await put('decks/dk1', { title: s('Airway deck'), addedBy: s(uid) });
  // Warm-up: a first visit may write summaries (e.g. a paper's presented list); both builds then read the same data.
  for (const scr of SCREENS) { await p.goto(`http://localhost:5000/?emulator=${PROJECT}#/${scr}`); await p.waitForTimeout(1200); }
  await ctx.close();

  for (const width of [390, 1280]) for (const scheme of ['light', 'dark']) {
    for (const [name, origin] of [['before', BASE], ['after', 'http://localhost:5000']]) {
      const c = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme, serviceWorkers: 'block' });
      const pg = await c.newPage();
      await pg.goto(`${origin}/?emulator=${PROJECT}`);
      await pg.evaluate(async () => { await window.__jc.signIn('chief@example.org'); });
      await pg.reload();
      await expect(pg.locator('#tabs')).toBeVisible({ timeout: 15000 });
      for (const scr of ['signin', ...SCREENS]) {
        if (scr === 'signin') continue;
        await pg.goto(`${origin}/?emulator=${PROJECT}#/${scr}`);
        await pg.waitForTimeout(1500);
        await pg.evaluate(() => document.fonts.ready);
        await pg.screenshot({ path: `${OUT}/${scr.replace(/\//g, '_')}-${width}-${scheme}-${name}.png`, fullPage: true });
      }
      await c.close();
      // Signed out: the sign-in page.
      const so = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme, serviceWorkers: 'block' });
      const sp = await so.newPage();
      await sp.goto(`${origin}/`);
      await expect(sp.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
      await sp.evaluate(() => document.fonts.ready);
      await sp.waitForTimeout(500);
      await sp.screenshot({ path: `${OUT}/signin-${width}-${scheme}-${name}.png`, fullPage: true });
      await so.close();
    }
  }
});

// Per-element probe (PROBE=route,route): the first elements whose box or computed style differs between the builds.
test('probe', async ({ browser }) => {
  test.skip(!process.env.PROBE);
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:5000/?emulator=${PROJECT}`);
  const uid = await p.evaluate(async () => { await window.__jc.signIn('chief@example.org'); return window.__jc.auth.currentUser.uid; });
  expect((await p.request.patch(`${DOCS}/members/${uid}`, { headers: owner, data: { fields: { email: s('chief@example.org'), name: s('Chief Admin'), role: s('admin'), inviteId: s('seed') } } })).ok()).toBeTruthy();
  expect((await p.request.patch(`${DOCS}/papers/pa`, { headers: owner, data: { fields: { title: s('Tranexamic acid'), journal: s('BJA'), year: { integerValue: '2024' }, doi: s('10.1/x'), abstract: s('Abs.'), tags: { arrayValue: { values: [s('t')] } }, addedBy: s(uid), changedAt: { timestampValue: '2026-10-01T00:00:00Z' } } } })).ok()).toBeTruthy();
  await ctx.close();
  const PROPS = ['font-family', 'font-size', 'font-weight', 'line-height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom', 'padding-left', 'border-top-width', 'border-bottom-width', 'color', 'background-color', 'border-radius', 'height', 'letter-spacing', 'box-shadow', 'outline-style', 'accent-color', 'appearance'];
  const dump = async (origin, route) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const pg = await c.newPage();
    await pg.goto(`${origin}/?emulator=${PROJECT}`);
    await pg.evaluate(async () => { await window.__jc.signIn('chief@example.org'); });
    await pg.reload();
    await expect(pg.locator('#tabs')).toBeVisible({ timeout: 15000 });
    await pg.goto(`${origin}/?emulator=${PROJECT}#/${route}`);
    await pg.waitForTimeout(1500);
    const out = await pg.evaluate((props) => [...document.querySelectorAll('body *')].map((e) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return { tag: e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '') + (e.type ? `[${e.type}]` : ''), y: Math.round(r.y), h: Math.round(r.height), st: Object.fromEntries(props.map((k) => [k, cs.getPropertyValue(k)])) };
    }), PROPS);
    await c.close();
    return out;
  };
  for (const route of process.env.PROBE.split(',')) {
    const [a, b] = [await dump('http://localhost:5001', route), await dump('http://localhost:5000', route)];
    let n = 0;
    for (let i = 0; i < Math.min(a.length, b.length) && n < 12; i++) {
      const d = Object.keys(a[i].st).filter((k) => a[i].st[k] !== b[i].st[k]).map((k) => `${k}: ${a[i].st[k]} -> ${b[i].st[k]}`);
      if (d.length || a[i].h !== b[i].h) { n++; console.log(`${route} ${a[i].tag} y${a[i].y}/${b[i].y} h${a[i].h}/${b[i].h} ${d.join('; ')}`); }
    }
    if (a.length !== b.length) console.log(`${route}: ${a.length} vs ${b.length} elements`);
  }
});
