import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentenceCase, strippedTitle, pageSpan, pageYear, crossrefYear, tidyPlan, tidyWrite, ATOTW_JOURNAL } from '../src/atotw-plan.js';
import { refreshId } from '../src/refresh.js';
import { findDuplicates } from '../src/dupes.js';
import { buildIndex, searchPapers } from '../src/search.js';
import { atotwNumber } from '../src/doi.js';

const PAGE = 'ANAESTHESIA TUTORIAL OF THE WEEK 453 20th May 2013 The Shoulder Block Dr A Author, Somewhere Hospital. Summary The brachial plexus ...';

test('title parser: the number and separators come off, underscores become spaces', () => {
  assert.equal(strippedTitle('ATOTW 453 The Shoulder Block'), 'The Shoulder Block');
  assert.equal(strippedTitle('atotw_453_shoulder_block'), 'shoulder block');
  assert.equal(strippedTitle('ATOTW-98 - Burns: first hours'), 'Burns: first hours');
  assert.equal(strippedTitle('ATOTW no. 7 Sedation'), 'Sedation');
  assert.equal(strippedTitle('ATOTW 453'), '');
  assert.equal(atotwNumber('ATOTW 453 The Shoulder Block'), 453);
});

test('page span: the file-name words come back in the page\'s own spelling; otherwise null', () => {
  assert.equal(pageSpan('shoulder block', PAGE), 'Shoulder Block');
  assert.equal(pageSpan('the shoulder block', PAGE), 'The Shoulder Block');
  assert.equal(pageSpan('knee block', PAGE), null);
  assert.equal(pageSpan('Sedation', PAGE), null); // one word is not enough to trust
});

test('page year needs the series name and a date', () => {
  assert.equal(pageYear(PAGE), 2013);
  assert.equal(pageYear('Tutorial of the Week, May 2025'), 2025);
  assert.equal(pageYear('A review published 20 May 2013'), null);
});

test('tidy: title from page 1, journal, year and number; hand edits stay; same twice changes nothing', () => {
  const p = { title: 'ATOTW 453 the_shoulder_block', journal: '', year: null, tags: [] };
  const plan = tidyPlan(p, PAGE);
  assert.equal(plan.status, 'change');
  assert.deepEqual(plan.next, { title: 'The shoulder block', journal: ATOTW_JOURNAL, year: 2013, atotw: 453 });
  const w = tidyWrite(p, plan);
  assert.deepEqual(w.manual.sort(), ['journal', 'title', 'year']);
  const after = { ...p, ...w };
  assert.equal(tidyPlan(after, PAGE).status, 'same');
  const hand = tidyPlan({ ...p, manual: ['title', 'year'], year: 2000 }, PAGE);
  assert.deepEqual(hand.next, { journal: ATOTW_JOURNAL, atotw: 453 });
  assert.equal(tidyWrite({ ...p, manual: ['title', 'year'] }, hand).manual.sort().join(), 'journal,title,year');
});

test('tidy: a lower-case file name gets a capital first letter', () => {
  assert.equal(tidyPlan({ title: 'ATOTW 12 sedation in icu' }, '').next.title, 'Sedation in icu');
});

test('tidy: no page text keeps the file-name title minus the number; year unchanged; nothing left is unsure', () => {
  assert.deepEqual(tidyPlan({ title: 'ATOTW 12 Sedation', year: 2009, journal: ATOTW_JOURNAL }, '').next, { title: 'Sedation', atotw: 12 });
  assert.equal(tidyPlan({ title: 'ATOTW 12' }, '').status, 'unsure');
  assert.equal(tidyPlan({ title: 'Propofol review' }, PAGE), null);
  assert.equal(tidyPlan({ title: 'ATOTW 9999 x' }, PAGE), null);
});

test('number field: refresh looks up by it, search finds "453", duplicates share it', () => {
  assert.equal(refreshId({ title: 'The Shoulder Block', atotw: 453 }), '10.28923/atotw.453');
  assert.equal(refreshId({ title: 'ATOTW 12 x' }), '10.28923/atotw.12');
  assert.equal(refreshId({ title: 'Shoulder Block' }), null);
  const ms = buildIndex(new Map([['a', { title: 'The Shoulder Block', atotw: 453 }], ['b', { title: 'Burns', atotw: 98 }]]));
  assert.deepEqual(searchPapers(ms, '453').map((r) => r.paperId), ['a']);
  const g = findDuplicates([['a', { title: 'Shoulder', atotw: 453 }], ['b', { title: 'Different words', atotw: 453 }], ['c', { title: 'Other', atotw: 7 }]]);
  assert.equal(g.length, 1);
  assert.equal(g[0].reason, 'Same ATOTW number');
});

test('sentence case: capitals lowered except acronyms; mixed-case acronyms and digits stay', () => {
  assert.equal(sentenceCase('SEDATION IN THE ICU'), 'Sedation in the ICU');
  assert.equal(sentenceCase('THE USE OF SGLT2 INHIBITORS IN PERIOPERATIVE CARE'), 'The use of SGLT2 inhibitors in perioperative care');
  assert.equal(sentenceCase('The Shoulder Block'), 'The shoulder block');
  assert.equal(sentenceCase('Management of ARDS and pH'), 'Management of ARDS and pH');
  assert.equal(sentenceCase('ECG INTERPRETATION'), 'ECG interpretation');
  assert.equal(sentenceCase('sedation in icu'), 'Sedation in icu');
  assert.equal(sentenceCase(sentenceCase('SEDATION IN THE ICU')), 'Sedation in the ICU');
});

test('year: a loose year on a file-named paper, a lookup when page 1 has none, never a guess', () => {
  const bare = 'Sedation in intensive care. Dr Jane Roe. First published 2011. The patient on the ventilator ...';
  assert.equal(pageYear(bare), null);
  assert.equal(pageYear(bare, true), 2011);
  assert.equal(pageYear('Cited 1998 in a paper', true), null);
  assert.equal(crossrefYear({ year: 2025 }), 2025);
  assert.equal(crossrefYear({ message: { issued: { 'date-parts': [[2024, 5, 1]] } } }), 2024);
  assert.equal(crossrefYear({}), null);
  const p = { title: 'ATOTW 553 hypotension' };
  assert.equal(tidyPlan(p, 'no date here').next.year, undefined);
  assert.equal(tidyPlan(p, 'no date here', 2025).next.year, 2025);
  assert.equal(tidyPlan({ ...p, manual: ['year'] }, 'x', 2025).next.year, undefined);
});
