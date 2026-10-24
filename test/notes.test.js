import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortNotes, filterNotes, millis } from '../src/notes.js';

const rows = [
  { title: 'Remifentanil in labour', text: 'Check the PCA dose', ms: 100 },
  { title: 'Caudal blocks', text: 'Bring the ultrasound notes', ms: 300 },
  { title: 'Sugammadex', text: 'Dose by actual weight', ms: 200 },
];

test('my notes are newest first', () => {
  assert.deepEqual(sortNotes(rows).map((r) => r.ms), [300, 200, 100]);
  assert.deepEqual(rows.map((r) => r.ms), [100, 300, 200]); // the input is not reordered
});

test('the search needs every word, in the title or the note, in any case', () => {
  assert.equal(filterNotes(rows, '').length, 3);
  assert.deepEqual(filterNotes(rows, 'DOSE').map((r) => r.title), ['Remifentanil in labour', 'Sugammadex']);
  assert.deepEqual(filterNotes(rows, 'dose weight').map((r) => r.title), ['Sugammadex']);
  assert.deepEqual(filterNotes(rows, 'caudal ultrasound').map((r) => r.title), ['Caudal blocks']);
  assert.equal(filterNotes(rows, 'zebrafish').length, 0);
});

test('millis reads a Firestore timestamp, a number, or nothing', () => {
  assert.equal(millis({ toMillis: () => 5 }), 5);
  assert.equal(millis(7), 7);
  assert.equal(millis(undefined), 0);
});
