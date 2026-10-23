// scripts/tidy-atotw.mjs against the Firestore emulator: report, apply with a before-file, skip edited/manual fields, restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DOCS = 'http://127.0.0.1:8080/v1/projects/demo-jc/databases/(default)/documents';
const H = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const s = (v) => ({ stringValue: v });
const put = (id, f) => fetch(`${DOCS}/papers/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { journal: s(''), tags: { arrayValue: {} }, ...f } }) }).then((r) => assert.ok(r.ok));
const get = (id) => fetch(`${DOCS}/papers/${id}`, { headers: H }).then((r) => r.json()).then((d) => d.fields);
const lines = (...a) => execFileSync('node', ['scripts/tidy-atotw.mjs', '--project', 'demo-jc', '--emulator', '127.0.0.1:8080', ...a], { encoding: 'utf8' });

test('tidy script: report changes nothing; apply writes, saves a before-file, keeps manual fields; restore puts it back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tidy-'));
  const pages = join(dir, 'pages.json');
  writeFileSync(pages, JSON.stringify({
    a1: 'ANAESTHESIA TUTORIAL OF THE WEEK 242 9th January 2012 SEDATION IN THE ICU Dr Jane Roe.',
    a2: 'ANAESTHESIA TUTORIAL OF THE WEEK 553 12 May 2025 Hypotension under anaesthesia',
  }));
  await put('a1', { title: s('ATOTW 242 sedation in the icu'), file: { mapValue: { fields: { pages: { integerValue: '1' } } } } });
  await put('a2', { title: s('ATOTW 553 hypotension'), year: { integerValue: '1999' }, manual: { arrayValue: { values: [s('year')] } }, file: { mapValue: { fields: { pages: { integerValue: '1' } } } } });
  await put('o1', { title: s('Unrelated trial') });

  const report = JSON.parse(lines('--pages', pages));
  assert.equal(report.atotwPapers, 2);
  assert.equal(report.change, 2);
  assert.equal((await get('a1')).title.stringValue, 'ATOTW 242 sedation in the icu'); // report only

  const out = lines('--pages', pages, '--apply', '--out', dir);
  assert.match(out, /"written":2/);
  const a1 = await get('a1'), a2 = await get('a2');
  assert.equal(a1.title.stringValue, 'Sedation in the ICU');
  assert.equal(a1.journal.stringValue, 'Anaesthesia Tutorial of the Week');
  assert.equal(a1.year.integerValue, '2012');
  assert.equal(a1.atotw.integerValue, '242');
  assert.equal(a2.title.stringValue, 'Hypotension');
  assert.equal(a2.year.integerValue, '1999'); // typed by hand
  assert.equal((await get('o1')).title.stringValue, 'Unrelated trial');
  assert.ok(a1.changedAt.timestampValue);

  assert.equal(JSON.parse(lines('--pages', pages)).change, 0); // again: nothing to do

  const before = JSON.parse(readFileSync(join(dir, 'before.json'), 'utf8'));
  assert.equal(before.a1.title, 'ATOTW 242 sedation in the icu');
  assert.match(lines('--restore', join(dir, 'before.json')), /"restored":2/);
  const back = await get('a1');
  assert.equal(back.title.stringValue, 'ATOTW 242 sedation in the icu');
  assert.equal(back.year, undefined);
  assert.equal(back.atotw, undefined);
});
