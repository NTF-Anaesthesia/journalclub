import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { titleFromFileName, headingFromPage, pickTitle, aiTitle } from '../lib/names.js';
import { splitPages, hasText } from '../lib/pdftext.js';
import { parseFolderArg } from '../lib/scan.js';
import { loadState, saveState } from '../lib/state.js';
import { politeFetch, pool } from '../lib/throttle.js';
import { ollamaAi } from '../lib/ollama.js';
import { analyse, libraryIndex, csv, counts, MAX_PDF } from '../lib/pipeline.js';
import { applyOne, paperFields, indexablePages } from '../lib/apply.js';
import { listRows, planRow } from '../lib/doilist.js';
import { fixtureFetch } from '../../../test/fixture-fetch.js';

const PROSE = 'Sedation in the intensive care unit is given to relieve anxiety and to permit tolerance of the tube. '.repeat(4);
const ATOTW = `ANAESTHESIA TUTORIAL OF THE WEEK 551 SGLT-2 Receptor Inhibitors: Pharmacology and Anaesthetic Implications 9th January 2012 SUMMARY ${PROSE} QUESTIONS Before reading this tutorial answer these.`;

test('titleFromFileName drops journal series prefixes and citation tails', () => {
  assert.equal(titleFromFileName('CEACCP Made up topic and more 2001-Smith-89-92.pdf'), 'Made up topic and more');
  assert.equal(titleFromFileName('BJAEd Another made-up topic 2016-Jones-e12-e15.pdf'), 'Another made-up topic');
  assert.equal(titleFromFileName('ATOTW 551 Made up tutorial 2012 Brown.pdf'), 'Made up tutorial');
  assert.equal(titleFromFileName('CEACCP Only a title.pdf'), 'Only a title');
  assert.equal(titleFromFileName('Made up trial 2019 Smith.pdf'), 'Made up trial 2019 Smith');
});

test('titleFromFileName drops prefixes and suffixes, keeps real hyphens', () => {
  assert.equal(titleFromFileName('AICM_202405 Acid-base-physiology.pdf'), 'Acid base physiology');
  assert.equal(titleFromFileName('CRASH-3 2019 TXA in TBI.pdf'), 'CRASH-3 2019 TXA in TBI');
  assert.equal(titleFromFileName('Made_up_topic_2023_mpaic.pdf'), 'Made up topic');
  assert.equal(titleFromFileName('.pdf'), 'Untitled PDF');
});

test('headingFromPage skips running headers and boilerplate, pickTitle falls back to the file name', () => {
  const page = 'Original Article\nhttps://doi.org/10.1000/x\nA made-up randomised trial of warm saline in adults\nJane Roe, John Doe';
  assert.equal(headingFromPage(page), 'A made-up randomised trial of warm saline in adults');
  assert.equal(headingFromPage('Page 1\n12 3 4\n'), null);
  assert.deepEqual(pickTitle('Some-file-name.pdf', 'x y'), { title: 'Some file name', from: 'filename' });
  assert.equal(pickTitle('f.pdf', page).from, 'heading');
});

test('headingFromPage joins a wrapped title and skips side boxes, affiliations, captions and second lines', () => {
  const wrapped = 'WARM SALINE VERSUS COLD SALINE FOR MADE-UP OUTCOMES IN ADULTS\nAND THE PLACEBO GROUP\nJane Roe';
  assert.equal(headingFromPage(wrapped), 'Warm saline versus cold saline for made-up outcomes in adults and the placebo group');
  assert.equal(headingFromPage('Do made-up trials of warm saline benefit from\nlarger samples? A pretend study\nJane Roe'),
    'Do made-up trials of warm saline benefit from larger samples? A pretend study');
  assert.equal(headingFromPage('AND THE MADE-UP SYNDROME OF WARM HANDS\nA made-up trial of cold hands in adults'), 'A made-up trial of cold hands in adults');
  assert.equal(headingFromPage('Made-up warming Learning objectives\nof cold rooms After reading this article, you'), 'Made-up warming');
  assert.equal(headingFromPage('Jane Roe, Pretend University School of Medicine, Nowhere\nA made-up review of warm saline today'), 'A made-up review of warm saline today');
  assert.equal(headingFromPage('Fig 2. (a) A made-up needle under pretend control in a model\nA made-up review of warm saline today'), 'A made-up review of warm saline today');
});

test('pickTitle: a series file name wins over a cut heading, without its cut last word', () => {
  const page = 'MADE-UP SECTION\nMade-up warming Learning objectives\nof cold rooms in pretend wards';
  assert.deepEqual(pickTitle('AICM_202401 Made-up-warming-of-cold-rooms_2024_mpaic.pdf', page), { title: 'Made up warming of cold rooms', from: 'filename' });
  assert.deepEqual(pickTitle('AICM_202401 Made-up-warming-of-cold-ro.pdf', page), { title: 'Made up warming of cold', from: 'filename' });
  assert.equal(titleFromFileName('AICM_202405 Made-up-topic--a-review_2024_Anaesthesia---Intensive-Care.pdf'), 'Made up topic: a review');
});

test('aiTitle keeps a model title only when it is printed on the page', () => {
  const page = `Pretend Journal\nA made-up trial of warm\nsaline in adults\n${PROSE}`;
  const ai = (response) => ({ run: async () => ({ response }) });
  return Promise.all([
    aiTitle(ai('Title: "A made-up trial of warm saline in adults"'), 'f.pdf', page).then((t) => assert.equal(t, 'A made-up trial of warm saline in adults')),
    aiTitle(ai('A study of something else entirely here'), 'f.pdf', page).then((t) => assert.equal(t, null)),
    aiTitle(ai('NONE'), 'f.pdf', page).then((t) => assert.equal(t, null)),
    aiTitle(null, 'f.pdf', page).then((t) => assert.equal(t, null)),
  ]);
});

test('splitPages ends pages at form feeds and hasText spots scanned PDFs', () => {
  assert.deepEqual(splitPages('one\ftwo\f'), ['one', 'two']);
  assert.equal(hasText(['', '', '']), false);
  assert.equal(hasText([PROSE]), true);
});

test('parseFolderArg reads an optional tag', () => {
  assert.deepEqual(parseFolderArg('/a/b=guideline-trial'), { dir: '/a/b', tag: 'guideline-trial' });
  assert.deepEqual(parseFolderArg('/a/b'), { dir: '/a/b', tag: '' });
});

test('state file: the last line per hash wins and a torn last line is ignored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'di-')), 's.jsonl');
  const m = loadState(path);
  saveState(path, m, { hash: 'h1', stage: 'analysed', status: 'new' });
  saveState(path, m, { hash: 'h1', stage: 'uploaded', paperId: 'p1' });
  writeFileSync(path, readFileSync(path, 'utf8') + '{"hash":"h2","sta');
  const again = loadState(path);
  assert.deepEqual(again.get('h1'), { hash: 'h1', stage: 'uploaded', status: 'new', paperId: 'p1' });
  assert.equal(again.has('h2'), false);
});

test('politeFetch spaces calls to one host and names the caller; pool limits concurrency', async () => {
  let t = 0; const slept = []; const seen = [];
  const f = politeFetch('me@example.org', async (u, o) => { seen.push(o.headers['User-Agent']); return new Response('ok'); },
    async (ms) => { slept.push(ms); t += ms; }, () => t);
  await f('https://api.crossref.org/works/1'); await f('https://api.crossref.org/works/2'); await f('https://example.org/');
  assert.deepEqual(slept, [120]);
  assert.match(seen[0], /mailto:me@example.org/);
  let live = 0, peak = 0;
  await pool([1, 2, 3, 4, 5], 2, async () => { peak = Math.max(peak, ++live); await new Promise((r) => setTimeout(r, 5)); live--; });
  assert.equal(peak, 2);
});

test('ollamaAi answers in the shape the Worker summary code reads', async () => {
  let sent;
  const ai = ollamaAi('m', 'http://x', async (u, o) => { sent = JSON.parse(o.body); return Response.json({ message: { content: 'text' } }); });
  assert.deepEqual(await ai.run('ignored', { messages: [{ role: 'user', content: 'q' }], max_tokens: 5, temperature: 0.2 }), { response: 'text' });
  assert.equal(sent.model, 'm'); assert.equal(sent.think, false); assert.equal(sent.options.num_predict, 5);
});

const entry = (name, size = 200000) => ({ path: '/x/' + name, name, size, hash: 'h-' + name });
const ctx = (over = {}) => ({
  pagesOf: async () => [ATOTW, 'page two'], lib: libraryIndex([]), batch: { keys: new Map() },
  fetchFn: fixtureFetch(), email: 'a@b.c', ...over,
});

test('analyse identifies an ATOTW PDF from its file name and fills metadata with no network', async () => {
  const rec = await analyse(entry('ATOTW 551 made-up.pdf'), ctx());
  assert.equal(rec.status, 'new');
  assert.equal(rec.doi, '10.28923/atotw.551');
  assert.equal(rec.via, 'atotw');
  assert.ok(rec.abstract.length > 100);
});

test('analyse falls back to the PDF abstract, then to the file name, and flags what is missing', async () => {
  const rec = await analyse(entry('AICM_202405 Made-up-topic.pdf', 10000), ctx({ pagesOf: async () => [ATOTW.replace('551', '9999999')], fetchFn: async () => new Response('', { status: 404 }) }));
  assert.equal(rec.abstractSource, 'pdf');
  assert.equal(rec.title, 'Made up topic');
  assert.match(rec.problem, /small file/);
});

test('analyse marks scanned and oversize files and skips them', async () => {
  assert.equal((await analyse(entry('s.pdf'), ctx({ pagesOf: async () => ['', ''] }))).status, 'needs-ocr');
  assert.equal((await analyse(entry('big.pdf', MAX_PDF + 1), ctx())).status, 'too-big');
});

test('analyse: duplicates in the batch and in the library; a library paper without a PDF is attached to', async () => {
  const c = ctx({ lib: libraryIndex([{ id: 'L1', doi: '', title: 'Made up topic', hasFile: true }, { id: 'L2', doi: '10.28923/ATOTW.551', title: 'x', hasFile: false }]) });
  const stub = (doi, title) => async () => ({ found: { doi, title, abstract: 'a'.repeat(200) }, via: 'pdf-doi', abstractSource: 'lookup' });
  assert.equal((await analyse(entry('a.pdf'), { ...c, enrichFn: stub('', 'Made up topic') })).status, 'in-library');
  const attach = await analyse(entry('b.pdf'), { ...c, enrichFn: stub('10.28923/atotw.551', 'Other') });
  assert.deepEqual([attach.status, attach.dupOf], ['attach', 'L2']);
  assert.equal((await analyse(entry('c.pdf'), { ...c, enrichFn: stub('10.1/new', 'Fresh') })).status, 'new');
  assert.equal((await analyse(entry('d.pdf'), { ...c, enrichFn: stub('10.1/NEW', 'Fresh again') })).status, 'dup-in-batch');
});

test('csv quotes cells and counts group by status', () => {
  const recs = [{ file: 'a "b".pdf', status: 'new', title: 'T, 1' }, { file: 'c.pdf', status: 'new' }, { file: 'd.pdf', status: 'needs-ocr' }];
  assert.match(csv(recs), /"a ""b"".pdf","new","","","T, 1"/);
  assert.deepEqual(counts(recs), { new: 2, 'needs-ocr': 1 });
});

test('paperFields matches what the app writes; indexablePages shrinks to the Worker cap', () => {
  const f = paperFields({ title: 'T', abstract: 'abs', abstractSource: 'pdf' }, ['AICM'], 'libraryimport', 'TS');
  assert.deepEqual(Object.keys(f).sort(), ['abstract', 'abstractSource', 'addedAt', 'addedBy', 'authors', 'changedAt', 'doi', 'journal', 'oa', 'pmid', 'tags', 'title', 'why', 'year']);
  assert.equal(paperFields({ title: 'T' }, [], 'u', 'TS').abstractSource, undefined);
  const big = Array.from({ length: 200 }, () => 'x'.repeat(19000));
  const out = indexablePages(big);
  assert.ok(out && out.reduce((s, p) => s + p.length, 0) <= 2 * 1024 * 1024);
});

test('applyOne creates once, uploads, indexes, and resumes from the state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'di-'));
  const path = join(dir, 'a.pdf'); writeFileSync(path, '%PDF-1.4 made up');
  const calls = [];
  const io = {
    createPaper: async () => { calls.push('create'); return 'P1'; },
    put: async (p) => { calls.push('put ' + p); return { ok: true }; },
    setFile: async (id, file) => calls.push('file ' + id + ' ' + file.pages),
  };
  const saved = [];
  const e = { path, name: 'a.pdf' };
  const deps = { pagesOf: async () => ['one', 'two'], io, tags: ['AICM'], save: (r) => saved.push(r) };
  assert.equal(await applyOne(e, { hash: 'h', status: 'new', title: 'T' }, deps), 'P1');
  assert.deepEqual(calls, ['create', 'put /api/file/P1', 'put /api/index/P1', 'file P1 2']);
  assert.deepEqual(saved.map((s) => s.stage), ['created', 'uploaded']);
  calls.length = 0;
  await applyOne(e, { hash: 'h', status: 'new', paperId: 'P1', stage: 'created' }, deps);
  assert.deepEqual(calls.filter((c) => c === 'create'), []);
  calls.length = 0;
  await applyOne(e, { hash: 'h', status: 'done', paperId: 'P1', stage: 'uploaded' }, deps);
  assert.deepEqual(calls, []);
  await applyOne(e, { hash: 'h', status: 'attach', dupOf: 'L9' }, deps);
  assert.ok(calls.includes('put /api/file/L9') && !calls.includes('create'));
});

test('applyOne fails loudly when the Worker refuses the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'di-'));
  const path = join(dir, 'a.pdf'); writeFileSync(path, 'x');
  const io = { createPaper: async () => 'P', put: async () => ({ ok: false, status: 403 }), setFile: async () => {} };
  await assert.rejects(applyOne({ path }, { hash: 'h', status: 'new' }, { pagesOf: async () => ['a'], io, tags: [], save() {} }), /file upload 403/);
});

test('DOI list: CSV with quoted commas, tags merged, take-home only when missing', () => {
  const rows = listRows('doi,pmid,short_name,year,takehome,tags\n10.1/ABC,1,Made-up A,2020,"Cut deaths, ""a lot""",icu; Trial\n,,empty,,,\n10.1/def,,B,2021,Line,\n', ['extra']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: '10.1/ABC', doi: '10.1/abc', name: 'Made-up A', why: 'Cut deaths, "a lot"', tags: ['icu', 'trial', 'extra'] });
  assert.deepEqual(planRow(rows[0], null), { status: 'new' });
  assert.deepEqual(planRow(rows[0], { id: 'p1', tags: ['icu'], why: '' }),
    { status: 'update', id: 'p1', update: { tags: ['icu', 'trial', 'extra'], why: 'Cut deaths, "a lot"' } });
  assert.deepEqual(planRow(rows[0], { id: 'p1', tags: ['trial', 'icu', 'extra'], why: 'Mine' }), { status: 'same', id: 'p1' });
});
