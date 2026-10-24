import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckItem, sessionItem, metaMatch, matchSlides } from '../src/decks.js';

const deck = deckItem('d1', { title: 'Difficult airway', by: 'Pat Presenter', tags: ['airway'], about: 'Front of neck access', slidesFile: { kind: 'pptx', pdf: true } });
const sess = sessionItem('s1', { paperTitle: 'Sugammadex &amp; PPCs', presenterName: 'Ann', slidesFile: { kind: 'pdf', pdf: true } });

test('decks and session slides become one kind of item', () => {
  assert.equal(deck.key, 'deck_d1');
  assert.equal(deck.href, '#/deck/d1');
  assert.equal(deck.original, true);
  assert.equal(sess.key, 'sess_s1');
  assert.equal(sess.title, 'Sugammadex & PPCs');
  assert.equal(sess.href, '#/session/s1');
  assert.equal(sessionItem('s2', { paperTitle: 'No slides' }), null);
  assert.equal(sessionItem('s3', { paperTitle: 'Linked', slides: 'https://example.org/x' }).url, 'https://example.org/x');
});

test('metaMatch: every word starts a word of the title, presenter, topics or description', () => {
  assert.ok(metaMatch(deck, 'airw'));
  assert.ok(metaMatch(deck, 'pat neck'));
  assert.ok(!metaMatch(deck, 'airway sugammadex'));
  assert.ok(metaMatch(deck, 'airway -cricoid'));
  assert.ok(!metaMatch(deck, ''));
});

test('matchSlides: metadata hits first with the server slide, then text-only hits; paper hits are ignored', () => {
  const server = [{ paperId: 'p9', page: 2, snippet: 'x' }, { paperId: 'sess_s1', page: 4, snippet: 'reversal' }, { paperId: 'deck_d1', page: 3, snippet: 'airway' }];
  const out = matchSlides([deck, sess], 'airway', server);
  assert.deepEqual(out.map((h) => [h.item.key, h.page]), [['deck_d1', 3], ['sess_s1', 4]]);
  assert.deepEqual(matchSlides([deck, sess], 'airway').map((h) => h.item.key), ['deck_d1']);
});
