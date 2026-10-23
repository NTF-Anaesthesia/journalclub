import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDoi, atotwDoi } from '../src/doi.js';
import { parseId } from '../worker/lookup.js';

test('findDoi reads the first DOI and drops trailing punctuation', () => {
  assert.equal(findDoi('Br J Anaesth 2019. doi: 10.1016/j.bja.2019.01.001. Epub'), '10.1016/j.bja.2019.01.001');
  assert.equal(findDoi('Lancet (https://doi.org/10.1016/S0140-6736(20)30183-5)'), '10.1016/S0140-6736(20)30183-5');
  assert.equal(findDoi('see (doi:10.1056/NEJMoa1305889), and'), '10.1056/NEJMoa1305889');
  assert.equal(findDoi('No identifier on this page'), null);
  assert.equal(findDoi(''), null);
});

test('atotwDoi reads Anaesthesia Tutorial of the Week numbers from file names and pages', () => {
  assert.equal(atotwDoi('ATOTW 551 SGLT2 inhibitors.pdf'), '10.28923/atotw.551');
  assert.equal(atotwDoi('2024_atotw_0551.pdf'), '10.28923/atotw.551');
  assert.equal(atotwDoi('ATOTW-412-burns.pdf'), '10.28923/atotw.412');
  assert.equal(atotwDoi('ATOTW no. 98'), '10.28923/atotw.98');
  assert.equal(atotwDoi('ANAESTHESIA TUTORIAL OF THE WEEK  Tutorial 551  20 May 2025'), '10.28923/atotw.551');
  assert.equal(atotwDoi('Tutorial 551 on something'), null);
  assert.equal(atotwDoi('Smith 2019 BJA review.pdf'), null);
  assert.equal(atotwDoi('watotw5.pdf'), null);
  assert.equal(atotwDoi(''), null);
  assert.deepEqual(parseId('ATOTW 551'), { doi: '10.28923/atotw.551' });
  assert.deepEqual(parseId('10.28923/atotw.551'), { doi: '10.28923/atotw.551' });
});
