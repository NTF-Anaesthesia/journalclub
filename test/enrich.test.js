import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDois, findPmid, titleInText, extractAbstract, atotwDetails, enrich, aiSummary } from '../worker/enrich.js';
import { fixtureFetch } from './fixture-fetch.js';

const ATOTW_OLD = 'ANAESTHESIA TUTORIAL OF THE WEEK 242 9th January 2012 Dr Jane Roe, Specialist Registrar Correspondence to jane@example.org '
  + 'SUMMARY Sedation in the intensive care unit is given to relieve anxiety, to permit tolerance of the endotracheal tube and to reduce '
  + 'oxygen consumption. This tutorial describes the common agents, how depth is scored, and why daily interruption of infusions shortens ventilation. '
  + 'QUESTIONS Before reading this tutorial, please answer the following questions. 1. Which agent accumulates in renal failure?';

test('findDois reads the first page first, joins a DOI broken after a dash or slash, and drops punctuation', () => {
  assert.deepEqual(findDois(['Published online. doi:10.1111/anae.12345.', 'cited 10.1000/xyz123']), ['10.1111/anae.12345', '10.1000/xyz123']);
  assert.deepEqual(findDois(['https://doi.org/10.1056/NEJMoa- 1305889 more text']), ['10.1056/nejmoa-1305889']);
  assert.deepEqual(findDois(['no identifier here']), []);
});

test('findPmid', () => {
  assert.equal(findPmid(['x PMID: 23992602 y']), '23992602');
  assert.equal(findPmid(['x PMID 12 y']), null);
});

test('titleInText needs the looked-up title to be printed in the PDF', () => {
  assert.equal(titleInText('Why Most Published Research Findings Are False', 'PLoS Medicine. Essay. Why most published research findings are false. John Ioannidis'), true);
  assert.equal(titleInText('Alogliptin after acute coronary syndrome', 'a paper about sedation in intensive care'), false);
  assert.equal(titleInText('Short', 'Short'), false);
});

test('extractAbstract takes an ATOTW summary up to the next heading', () => {
  const a = extractAbstract([ATOTW_OLD]);
  assert.equal(a.heading, 'SUMMARY');
  assert.match(a.text, /^Sedation in the intensive care unit/);
  assert.match(a.text, /shortens ventilation\.$/);
  assert.doesNotMatch(a.text, /QUESTIONS|Before reading/);
});

test('extractAbstract keeps structured labels, stops at Keywords, and ignores a heading list', () => {
  const j = 'Title of a trial. Abstract Background: Nausea is common after surgery. Methods: We randomised 200 patients to drug or placebo. '
    + 'Results: Drug halved nausea (RR 0.5). Conclusions: Drug works and is cheap, so it should be used widely in practice. Keywords: nausea, drug 1 Introduction Nausea is bad.';
  const a = extractAbstract([j]);
  assert.match(a.text, /^Background: Nausea is common/);
  assert.match(a.text, /used widely in practice\.$/);
  assert.equal(extractAbstract(['Contents Summary Introduction Methods Results Discussion References']), null);
  assert.equal(extractAbstract(['Summary tiny. Introduction ' + 'x'.repeat(50)]), null);
});

test('atotwDetails', () => {
  assert.deepEqual(atotwDetails(ATOTW_OLD), { journal: 'Anaesthesia Tutorial of the Week', year: 2012 });
  assert.equal(atotwDetails('Annals of Surgery 2012'), null);
});

test('enrich: an old ATOTW PDF gets its summary, journal and year from the PDF, after a miss on the made-up DOI', async () => {
  const out = await enrich({ pages: [ATOTW_OLD], paper: { title: 'ATOTW 242 sedation' }, fetchFn: fixtureFetch(), email: 'a@b.c' });
  assert.equal(out.abstractSource, 'pdf');
  assert.match(out.found.abstract, /^Sedation in the intensive care unit/);
  assert.equal(out.found.journal, 'Anaesthesia Tutorial of the Week');
  assert.equal(out.found.year, 2012);
  assert.equal(out.via, null);
});

test('enrich: a DOI printed in the PDF is looked up and accepted only when the title is on the page', async () => {
  const good = await enrich({ pages: ['Why Most Published Research Findings Are False. John Ioannidis. doi:10.1371/journal.pmed.0020124'],
    paper: { title: 'handout' }, fetchFn: fixtureFetch(), email: 'a@b.c' });
  assert.equal(good.via, 'pdf-doi');
  assert.equal(good.found.title, 'Why Most Published Research Findings Are False');
  assert.equal(good.found.year, 2005);
  const cited = await enrich({ pages: ['A paper on nothing in particular that cites doi:10.1371/journal.pmed.0020124 in passing'],
    paper: { title: 'handout' }, fetchFn: fixtureFetch(), email: 'a@b.c' });
  assert.equal(cited.via, null);
  assert.equal(cited.found.doi, undefined);
});

test('enrich: no PDF text means nothing to do; AI only when asked, never over a PDF abstract', async () => {
  assert.equal((await enrich({ pages: [], fetchFn: fixtureFetch(), email: 'a@b.c' })).hasText, false);
  const calls = [];
  const ai = { run: async (model, req) => { calls.push(req); return { response: 'A short neutral summary of the handout that is long enough to be kept as a summary.' }; } };
  const leftovers = ['Ward round handout. '.repeat(40)];
  const off = await enrich({ pages: leftovers, paper: { title: 'handout' }, fetchFn: fixtureFetch(), email: 'a@b.c' });
  assert.equal(off.abstractSource, null);
  assert.equal(calls.length, 0);
  const on = await enrich({ pages: leftovers, paper: { title: 'handout' }, fetchFn: fixtureFetch(), email: 'a@b.c', ai });
  assert.equal(on.abstractSource, 'ai');
  assert.equal(calls.length, 1);
  const withPdf = await enrich({ pages: [ATOTW_OLD], paper: { title: 'x' }, fetchFn: fixtureFetch(), email: 'a@b.c', ai });
  assert.equal(withPdf.abstractSource, 'pdf');
  assert.equal(calls.length, 1);
});

test('aiSummary drops NONE and very short answers', async () => {
  const text = 'word '.repeat(200);
  assert.equal(await aiSummary({ run: async () => ({ response: 'NONE' }) }, text), null);
  assert.equal(await aiSummary({ run: async () => ({ response: 'Too short.' }) }, text), null);
  assert.equal(await aiSummary({ run: async () => { throw new Error('quota'); } }, text), null);
  assert.equal(await aiSummary(null, text), null);
});
