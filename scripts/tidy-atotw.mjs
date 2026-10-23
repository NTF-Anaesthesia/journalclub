// Tidy ATOTW without the app: the same rules as the Library's "Tidy ATOTW" sheet (src/atotw-plan.js), run over every
// ATOTW paper by an admin from a computer that is signed in to Google Cloud (gcloud) and Cloudflare (wrangler).
//   node scripts/tidy-atotw.mjs --project journalclub-anantf [--apply] [--out DIR] [--limit N]
//   node scripts/tidy-atotw.mjs --project P --repair OLD/before.json [--apply --out DIR]   (redo only titles/years of papers a first run wrote, with
//   the current rules, from the original titles in that before.json; a paper edited since that run is skipped)
//   tests: --emulator 127.0.0.1:8080 --pages pages.json   (pages.json: { "<paper id>": "<page 1 text>" })
// Without --apply it only reports. With --apply it first saves the old values of every paper it will change to
// DIR/before.json (put them back with --restore DIR/before.json), then writes one paper at a time; a paper edited since
// it was read is skipped. Fields in `manual` are never touched; papers sharing a number are skipped.
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tidyPlan, tidyWrite, crossrefYear } from '../src/atotw-plan.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i < 0 ? null : args[i + 1]; };
const flag = (k) => args.includes('--' + k);
const project = opt('project') || 'demo-jc', emu = opt('emulator'), out = opt('out') || '.', limit = Number(opt('limit')) || Infinity;
const base = (emu ? `http://${emu}/v1/` : 'https://firestore.googleapis.com/v1/') + `projects/${project}/databases/(default)/documents`;
const token = emu ? 'owner' : execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const val = (v) => v == null ? undefined : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue)
  : 'arrayValue' in v ? (v.arrayValue.values || []).map(val) : undefined;
const enc = (v) => Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v };

async function listPapers() {
  const mask = ['title', 'journal', 'year', 'atotw', 'manual', 'file'].map((f) => `mask.fieldPaths=${f}`).join('&');
  const all = [];
  for (let token2 = ''; ;) {
    const r = await fetch(`${base}/papers?pageSize=300&${mask}${token2 ? '&pageToken=' + encodeURIComponent(token2) : ''}`, { headers: H });
    if (!r.ok) throw new Error(`list papers: ${r.status} ${await r.text()}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const f = d.fields || {};
      all.push({ id: d.name.split('/').pop(), updateTime: d.updateTime, p: { title: val(f.title) || '', journal: val(f.journal) || '', year: val(f.year) ?? null,
        atotw: val(f.atotw) || null, manual: val(f.manual) || [], file: !!f.file } });
    }
    if (!j.nextPageToken) return all;
    token2 = j.nextPageToken;
  }
}

// Page 1 text from D1 (database journalclub-search), 40 papers per call, first 3000 characters of each.
function page1(ids) {
  const file = opt('pages');
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const res = {};
  for (let i = 0; i < ids.length; i += 40) {
    const list = ids.slice(i, i + 40).map((x) => `'${x.replace(/[^A-Za-z0-9_-]/g, '')}'`).join(',');
    const sql = `SELECT paper, SUBSTR(text, 1, 3000) AS text FROM page_text WHERE page = 1 AND paper IN (${list})`;
    // On Windows the shell splits the SQL on spaces, so pass it as one quoted argument (the SQL has no double quotes).
    const win = process.platform === 'win32';
    let o;
    for (let attempt = 1; ; attempt++) {
      try {
        o = execFileSync('npx', ['wrangler', 'd1', 'execute', 'journalclub-search', '--remote', '--json', '--command', win ? `"${sql}"` : sql], { encoding: 'utf8', shell: win, maxBuffer: 64e6 });
        break;
      } catch (e) { if (attempt === 3) throw e; }
    }
    for (const row of JSON.parse(o.slice(o.indexOf('[')))[0].results || []) res[row.paper] = row.text;
  }
  return res;
}

async function lookupYear(n) {
  try {
    const r = await fetch(`https://api.crossref.org/works/10.28923/atotw.${n}?mailto=journalclub@anantf.com`);
    return r.ok ? crossrefYear(await r.json()) : null;
  } catch { return null; }
}

async function patch(id, updateTime, p, plan) {
  const ch = tidyWrite(p, plan);
  const fields = Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, enc(v)]));
  const body = { writes: [{ update: { name: `projects/${project}/databases/(default)/documents/papers/${id}`, fields },
    updateMask: { fieldPaths: Object.keys(fields) }, updateTransforms: [{ fieldPath: 'changedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { updateTime } }] };
  const r = await fetch(`${base.replace(/\/documents$/, '')}/documents:commit`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return r.ok ? 'ok' : r.status === 409 || r.status === 412 ? "edited" : `error ${r.status} ${await r.text()}`;
}

async function restore(file) {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  let ok = 0;
  for (const [id, old] of Object.entries(before)) {
    const fields = Object.fromEntries(Object.entries(old).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, enc(v)]));
    const gone = Object.keys(old).filter((k) => old[k] === null || old[k] === undefined);
    const body = { writes: [{ update: { name: `projects/${project}/databases/(default)/documents/papers/${id}`, fields },
      updateMask: { fieldPaths: [...Object.keys(fields), ...gone] }, updateTransforms: [{ fieldPath: 'changedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true } }] };
    const r = await fetch(`${base.replace(/\/documents$/, '')}/documents:commit`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (r.ok) ok++;
  }
  console.log(JSON.stringify({ restored: ok, of: Object.keys(before).length }));
}

async function main() {
  if (opt('restore')) return restore(opt('restore'));
  const repair = opt('repair') ? JSON.parse(readFileSync(opt('repair'), 'utf8')) : null;
  const ranAt = repair ? statSync(opt('repair')).mtimeMs : 0;
  const papers = (await listPapers()).filter(({ id, p }) => repair ? id in repair : p.atotw || /^\s*atotw\b/i.test(p.title)).slice(0, limit);
  const pages = page1(papers.filter(({ p }) => p.file).map(({ id }) => id));
  const plans = new Map();
  for (const { id, updateTime, p } of papers) {
    if (repair) { // from the original title, with the rules as they are now; only title and year, and only if untouched since the first run
      const o = repair[id], untouched = Date.parse(updateTime) <= ranAt + 60 * 60e3;
      const pl = tidyPlan({ ...p, title: o.title, manual: o.manual || [] }, pages[id] || '');
      const next = {};
      if (pl?.next.title && pl.next.title !== p.title) next.title = pl.next.title;
      if (pl?.next.year && pl.next.year !== p.year && !p.manual.includes('year')) next.year = pl.next.year;
      plans.set(id, { n: p.atotw, next: untouched ? next : {}, status: !untouched ? 'unsure' : Object.keys(next).length ? 'change' : 'same', note: untouched ? '' : 'edited since the first run' });
      continue;
    }
    let plan = tidyPlan(p, pages[id] || '');
    if (plan && !plan.next.year && !p.year && plan.n >= 525 && !p.manual.includes('year')) plan = tidyPlan(p, pages[id] || '', await lookupYear(plan.n));
    if (plan) plans.set(id, plan);
  }
  const count = new Map();
  for (const pl of plans.values()) count.set(pl.n, (count.get(pl.n) || 0) + 1);
  for (const pl of plans.values()) if (!repair && count.get(pl.n) > 1) Object.assign(pl, { status: 'unsure', next: {}, note: 'same number as another paper' });
  const tally = { change: 0, same: 0, unsure: 0, noYear: 0 };
  for (const [id, pl] of plans) {
    tally[pl.status]++;
    const p = papers.find((x) => x.id === id).p;
    if (!pl.next.year && !p.year) tally.noYear++;
  }
  const changed = papers.filter(({ id }) => plans.get(id)?.status === 'change');
  const sample = changed.slice(0, repair ? 25 : 8).map(({ id, p }) => ({ id, from: p.title, ...plans.get(id).next }));
  console.log(JSON.stringify({ atotwPapers: papers.length, ...tally, repair: !!repair, apply: flag('apply'), sample }, null, 1));
  if (!flag('apply')) return;
  mkdirSync(out, { recursive: true });
  const before = Object.fromEntries(changed.map(({ id, p }) => [id, { title: p.title, journal: p.journal, year: p.year, atotw: p.atotw, manual: p.manual }]));
  writeFileSync(`${out}/before.json`, JSON.stringify(before, null, 1));
  const res = { ok: 0, edited: 0, errors: [] };
  for (const { id, updateTime, p } of changed) {
    const r = await patch(id, updateTime, p, plans.get(id));
    if (r === 'ok') res.ok++; else if (r === 'edited') res.edited++; else res.errors.push(`${id}: ${r}`);
  }
  console.log(JSON.stringify({ written: res.ok, skippedEditedMeanwhile: res.edited, errors: res.errors.slice(0, 5), errorCount: res.errors.length, beforeFile: `${out}/before.json` }));
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
