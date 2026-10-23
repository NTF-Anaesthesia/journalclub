#!/usr/bin/env node
// Adds papers from a DOI list (CSV: doi,pmid,short_name,year,takehome,tags) to the library, without PDFs. Dry run by
// default (prints what it would do); --apply writes. Papers already in the library only gain tags and a missing take-home.
//
//   node dois.js --key sa.json --csv list.csv [--tag extra] [--apply] [--email you@example.org]
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { lookup } from '../../worker/lookup.js';
import { firebaseConfig } from '../../src/config.js';
import { libraryIndex } from './lib/pipeline.js';
import { paperFields } from './lib/apply.js';
import { listRows, planRow, TAGS_MAX } from './lib/doilist.js';
import { politeFetch } from './lib/throttle.js';
import { connect, IMPORT_UID } from './lib/auth.js';

const { values: a } = parseArgs({ options: {
  key: { type: 'string' }, csv: { type: 'string' }, tag: { type: 'string', multiple: true },
  apply: { type: 'boolean', default: false }, email: { type: 'string', default: 'journalclub@anantf.com' },
} });
if (!a.key || !a.csv) {
  console.error('Usage: node dois.js --key sa.json --csv list.csv [--tag extra] [--apply]');
  process.exit(2);
}

const rows = listRows(readFileSync(a.csv, 'utf8'), a.tag || []);
const fb = await connect({ keyPath: a.key, apiKey: firebaseConfig.apiKey });
const papers = (await fb.db.collection('papers').select('doi', 'title', 'tags', 'why').get()).docs
  .map((d) => ({ id: d.id, doi: d.get('doi') || '', title: d.get('title') || '', tags: d.get('tags') || [], why: d.get('why') || '' }));
const lib = libraryIndex(papers);
const fetchFn = politeFetch(a.email);
const count = {};
const seen = new Set();

for (const row of rows) {
  let status, note = '';
  try {
    const found = await lookup(row.id, fetchFn, a.email);
    if (found.error) throw new Error(found.error);
    const key = (found.doi || row.doi).toLowerCase();
    if (seen.has(key)) { status = 'dup-in-list'; } else {
      seen.add(key);
      const plan = planRow(row, lib.find(found.doi, found.title));
      status = plan.status;
      if (plan.status === 'new') {
        note = found.title.slice(0, 70);
        if (a.apply) {
          const ts = fb.ts();
          const fields = { ...paperFields(found, row.tags.slice(0, TAGS_MAX), IMPORT_UID, ts), why: row.why, oa: found.oa };
          note += ` -> ${(await fb.db.collection('papers').add(fields)).id}`;
        }
      } else if (plan.status === 'update') {
        note = `${plan.id} ${Object.keys(plan.update).join('+')}`;
        if (a.apply) await fb.db.doc(`papers/${plan.id}`).update({ ...plan.update, changedAt: fb.ts() });
      } else note = plan.id;
    }
  } catch (e) { status = 'error'; note = e.message; }
  count[status] = (count[status] || 0) + 1;
  console.log(`${status}\t${row.name}\t${note}`);
}
console.log(`${a.apply ? 'applied' : 'dry run'}: ${JSON.stringify(count)}`);
process.exit(0);
