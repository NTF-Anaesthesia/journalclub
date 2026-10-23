import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FIELDS, normalizeFields, snapshot, answerText, sessionFields, missingRequired, inJoinWindow, startMillis, csvExport, sessionMarkdown } from '../src/discussion.js';

const ts = (iso) => { const d = new Date(`${iso}T00:00:00`); return { toDate: () => d, toMillis: () => d.getTime() }; };

test('normalizeFields drops bad types, dedupes ids, bounds list max and fills choice options', () => {
  const f = normalizeFields([
    { id: 'a', label: ' One ', type: 'list', max: 99 }, { id: 'a', label: 'Two', type: 'short' },
    { label: 'No type', type: 'nope' }, { label: '', type: 'long' }, { id: 'c', label: 'Pick', type: 'choice', options: [] },
  ]);
  assert.deepEqual(f.map((x) => x.id), ['a', 'ax', 'c']);
  assert.equal(f[0].label, 'One'); assert.equal(f[0].max, 10);
  assert.deepEqual(f[2].options, ['Yes', 'No']);
});

test('answerText joins lists and a choice with its note', () => {
  const [take, pr] = DEFAULT_FIELDS;
  assert.equal(answerText(take, { takehome: ['A', ' ', 'B'] }), 'A | B');
  assert.equal(answerText(pr, { practice: 'Maybe', 'practice~note': 'needs more data' }), 'Maybe — needs more data');
});

test('required fields are reported by label', () => {
  assert.deepEqual(missingRequired(DEFAULT_FIELDS, { takehome: ['x'] }), ['Would this change our practice?']);
});

test('Join window opens 15 min before the start and closes 2 h after', () => {
  const s = { date: ts('2026-11-05'), time: '16:00' };
  const start = startMillis(s);
  assert.equal(new Date(start).getHours(), 16);
  assert.equal(inJoinWindow(start, start - 16 * 60000), false);
  assert.equal(inJoinWindow(start, start - 14 * 60000), true);
  assert.equal(inJoinWindow(start, start + 119 * 60000), true);
  assert.equal(inJoinWindow(start, start + 121 * 60000), false);
});

test('a session saved under an old template keeps its labels in CSV and Markdown', () => {
  const oldSession = { id: 's1', date: ts('2026-10-01'), paperTitle: 'Paper, one', presenterName: 'Ada', coordinatorName: 'Dr C', summary: 'S',
    discussion: { fields: snapshot([{ id: 'q', label: 'Old question', type: 'long' }]), answers: { q: 'old answer' } } };
  const newTemplate = normalizeFields([{ id: 'q', label: 'Renamed question', type: 'long' }]);
  const newSession = { id: 's2', date: ts('2026-10-15'), paperTitle: 'Two', presenterName: 'Bo', summary: '',
    discussion: { fields: snapshot(newTemplate), answers: { q: '=HYPERLINK("x")' } } };
  assert.equal(sessionFields(oldSession, newTemplate)[0].label, 'Old question');
  const csv = csvExport([oldSession, newSession], newTemplate, { s1: [{ text: 'a point' }] });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Paper,Presenter,Coordinator,Summary,Old question,Renamed question,Members\' points');
  assert.equal(lines[1], '2026-10-01,"Paper, one",Ada,Dr C,S,old answer,,a point');
  assert.match(lines[2], /,"'=HYPERLINK\(""x""\)",/);
  assert.match(sessionMarkdown(oldSession, newTemplate), /## Old question\nold answer/);
});

test("an admin's form override for one session wins over the copy its discussion was saved with", () => {
  const saved = snapshot([{ id: 'q', label: 'Old question', type: 'long' }]);
  const override = normalizeFields([{ id: 'q', label: 'Would this change our practice? Why?', type: 'long' }]);
  const s = { discussion: { fields: saved, answers: { q: 'yes' } }, template: override };
  assert.equal(sessionFields(s, DEFAULT_FIELDS)[0].label, 'Would this change our practice? Why?');
  assert.match(sessionMarkdown({ ...s, date: ts('2026-10-01'), paperTitle: 'P' }, DEFAULT_FIELDS), /## Would this change our practice\? Why\?\nyes/);
});

test('an unfilled session uses the current template', () => {
  assert.equal(sessionFields({}, DEFAULT_FIELDS), DEFAULT_FIELDS);
});
