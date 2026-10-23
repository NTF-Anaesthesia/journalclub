import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDoi } from '../src/doi.js';

test('findDoi reads the first DOI and drops trailing punctuation', () => {
  assert.equal(findDoi('Br J Anaesth 2019. doi: 10.1016/j.bja.2019.01.001. Epub'), '10.1016/j.bja.2019.01.001');
  assert.equal(findDoi('Lancet (https://doi.org/10.1016/S0140-6736(20)30183-5)'), '10.1016/S0140-6736(20)30183-5');
  assert.equal(findDoi('see (doi:10.1056/NEJMoa1305889), and'), '10.1056/NEJMoa1305889');
  assert.equal(findDoi('No identifier on this page'), null);
  assert.equal(findDoi(''), null);
});
