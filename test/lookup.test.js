import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureFetch } from './fixture-fetch.js';
import { parseId, parseCrossref, parsePubmed, parseUnpaywall, lookup } from '../worker/lookup.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const key = (doi) => doi.replace(/[/.]/g, '_');
const NEJM = '10.1056/nejmoa1305889';
const PLOS = '10.1371/journal.pmed.0020124';

test('parseId accepts DOIs, DOI links and PubMed IDs', () => {
  assert.deepEqual(parseId('10.1056/NEJMoa1305889'), { doi: NEJM });
  assert.deepEqual(parseId('https://doi.org/10.1056/NEJMoa1305889'), { doi: NEJM });
  assert.deepEqual(parseId('doi:10.1371/journal.pmed.0020124.'), { doi: PLOS });
  assert.deepEqual(parseId('PMID: 23992602'), { pmid: '23992602' });
  assert.deepEqual(parseId(' 16060722 '), { pmid: '16060722' });
  assert.equal(parseId('alogliptin'), null);
  assert.equal(parseId(''), null);
});

test('parseCrossref reads title, authors, journal and year', () => {
  const p = parseCrossref(JSON.parse(fx('crossref-10_1371_journal_pmed_0020124.json')));
  assert.equal(p.title, 'Why Most Published Research Findings Are False');
  assert.deepEqual(p.authors, ['John P. A. Ioannidis']);
  assert.equal(p.journal, 'PLoS Medicine');
  assert.equal(p.year, 2005);
  assert.equal(p.doi, PLOS);
});

test('parsePubmed reads the abstract, PMID and DOI', () => {
  const p = parsePubmed(fx('pubmed-23992602.xml'));
  assert.equal(p.pmid, '23992602');
  assert.equal(p.doi, NEJM);
  assert.match(p.title, /^Alogliptin after acute coronary syndrome/);
  assert.match(p.abstract, /^BACKGROUND: /);
  assert.ok(p.authors.length > 3);
  assert.equal(p.year, 2013);
});

test('parseUnpaywall reads status and licence', () => {
  assert.deepEqual(parseUnpaywall(JSON.parse(fx('unpaywall-10_1371_journal_pmed_0020124.json'))).license, 'cc-by');
  const closed = parseUnpaywall(JSON.parse(fx('unpaywall-10_1056_NEJMoa1305889.json')));
  assert.equal(closed.status, 'bronze');
  assert.equal(closed.license, null);
  assert.equal(parseUnpaywall(null).status, 'unknown');
});

test('lookup by DOI merges Crossref, PubMed abstract and Unpaywall', async () => {
  const p = await lookup('https://doi.org/10.1371/journal.pmed.0020124', fixtureFetch(), 'x@example.org');
  assert.equal(p.title, 'Why Most Published Research Findings Are False');
  assert.equal(p.pmid, '16060722');
  assert.match(p.abstract, /^There is increasing concern/);
  assert.equal(p.oa.license, 'cc-by');
});

test('lookup by PMID finds the DOI and the closed licence', async () => {
  const p = await lookup('23992602', fixtureFetch(), 'x@example.org');
  assert.equal(p.doi, NEJM);
  assert.equal(p.journal, 'New England Journal of Medicine');
  assert.equal(p.oa.license, null);
});

test('lookup reports unknown ids', async () => {
  assert.equal((await lookup('10.9999/nothing', fixtureFetch(), 'x')).error, 'DOI not found');
  assert.equal((await lookup('1', fixtureFetch(), 'x')).error, 'PubMed ID not found');
  assert.equal((await lookup('hello', fixtureFetch(), 'x')).error, 'Not a DOI or PubMed ID');
});
