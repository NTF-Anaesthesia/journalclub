#!/usr/bin/env node
// Bulk import of PDFs from folders into the journal club library. Dry run by default (writes nothing, prints counts and a
// CSV report); --apply uploads. Resumable: the state file records every stage per file.
//
//   node import.js --key sa.json --state state.jsonl --folder DIR[=tag] [--folder DIR2 ...] [--report report.csv]
//                  [--apply] [--max N] [--model gemma4:12b] [--no-ai] [--site https://...] [--email you@example.org]
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { firebaseConfig } from '../../src/config.js';
import { enrich } from '../../worker/enrich.js';
import { scan, parseFolderArg } from './lib/scan.js';
import { extractPages } from './lib/pdftext.js';
import { loadState, saveState } from './lib/state.js';
import { analyse, libraryIndex, csv, counts } from './lib/pipeline.js';
import { applyOne, paperFields } from './lib/apply.js';
import { ollamaAi } from './lib/ollama.js';
import { politeFetch, pool } from './lib/throttle.js';
import { connect, IMPORT_UID } from './lib/auth.js';

const { values: a } = parseArgs({ options: {
  key: { type: 'string' }, state: { type: 'string' }, report: { type: 'string', default: 'report.csv' },
  folder: { type: 'string', multiple: true }, apply: { type: 'boolean', default: false }, max: { type: 'string' },
  model: { type: 'string', default: 'gemma4:12b' }, 'no-ai': { type: 'boolean', default: false },
  site: { type: 'string', default: 'https://journalclub.anantf.com' }, email: { type: 'string', default: 'journalclub@anantf.com' },
} });
if (!a.key || !a.state || !a.folder?.length) {
  console.error('Usage: node import.js --key sa.json --state state.jsonl --folder DIR[=tag] ... [--report r.csv] [--apply] [--max N]');
  process.exit(2);
}

const mb = (n) => (n / 1048576).toFixed(0);
const now = () => new Date().toISOString().slice(11, 19);

const entries = await scan(a.folder.map(parseFolderArg));
console.log(`${now()} scanned ${entries.length} PDFs, ${mb(entries.reduce((s, e) => s + e.size, 0))} MB`);

const fb = await connect({ keyPath: a.key, apiKey: firebaseConfig.apiKey });
const papers = (await fb.db.collection('papers').select('doi', 'title', 'file').get()).docs
  .map((d) => ({ id: d.id, doi: d.get('doi') || '', title: d.get('title') || '', hasFile: !!d.get('file'), bytes: d.get('file')?.size || 0 }));
console.log(`${now()} library: ${papers.length} papers, ${papers.filter((p) => p.hasFile).length} with a PDF, ${mb(papers.reduce((s, p) => s + p.bytes, 0))} MB stored`);

const lib = libraryIndex(papers);
const state = loadState(a.state);
const save = (rec) => saveState(a.state, state, rec);
const fetchFn = politeFetch(a.email);
const ai = a['no-ai'] ? null : ollamaAi(a.model);
const batch = { keys: new Map() };
const pagesOf = extractPages;
const results = [];

async function sendTo(path, body, type) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(a.site + path, { method: 'PUT', body, headers: { 'Content-Type': type, Authorization: `Bearer ${await fb.idToken()}` } });
    if (r.ok || attempt >= 3 || (r.status < 500 && r.status !== 429)) return r;
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
}
const io = {
  put: sendTo,
  createPaper: async (rec, tags) => (await fb.db.collection('papers').add(paperFields(rec, tags, IMPORT_UID, fb.ts()))).id,
  setFile: (id, file) => fb.db.doc(`papers/${id}`).update({ file, changedAt: fb.ts() }),
};

let applied = 0;
const limit = a.max ? Number(a.max) : Infinity;
let i = 0;
await pool(entries, 2, async (entry) => {
  let rec = state.get(entry.hash);
  if (rec?.stage === 'uploaded') { results.push(rec); return; }
  try {
    if (!rec?.status || rec.status === 'error') {
      rec = await analyse(entry, { pagesOf, lib, batch, fetchFn, email: a.email, ai, enrichFn: enrich });
      save(rec);
    } else {
      batch.keys.set(rec.doi ? rec.doi.toLowerCase() : (rec.title || '').toLowerCase(), entry.name);
      rec = { ...rec };
    }
    if (a.apply && ['new', 'attach'].includes(rec.status) && applied < limit) {
      applied++;
      await applyOne(entry, rec, { pagesOf, io, tags: entry.tag ? [entry.tag] : [], save });
      rec = state.get(entry.hash);
    }
  } catch (e) {
    const problem = `error: ${e.message}`;
    rec = { ...(rec || { file: entry.name }), hash: entry.hash, status: rec?.status || 'error', problem };
    save({ hash: entry.hash, file: entry.name, problem, ...(rec.status === 'error' ? { status: 'error' } : {}) });
  }
  results.push(rec);
  if (++i % 25 === 0) console.log(`${now()} ${i}/${entries.length}`);
});

writeFileSync(a.report, csv(results.sort((x, y) => x.file.localeCompare(y.file))));
console.log(`${now()} ${a.apply ? 'applied' : 'dry run'}: ${JSON.stringify(counts(results))}`);
console.log(`report: ${a.report}; uploaded this run: ${applied}`);
process.exit(0);
