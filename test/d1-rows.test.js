import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA, indexPages, indexNotes, removeFromIndex, indexedPapers, firstPages, search, ensureSchema, resetSchemaCache } from '../worker/search.js';
import { localD1 } from './d1.js';

const PAPERS = 50, PAGES = 20; // 1,000 pages
let d1;
before(async () => {
  d1 = await localD1();
  for (let p = 0; p < PAPERS; p++) {
    await indexPages(d1.db, `p${p}`, Array.from({ length: PAGES }, (_, i) => `paper ${p} page ${i + 1} filler words${p} ${i === 3 ? 'uniqueterm' + p : ''}`));
  }
  await indexNotes(d1.db, 'p0', ['a note about notable things']);
});
after(async () => { await d1?.dispose(); });

test('the meter is real: a full scan reads every row', async () => {
  const r = await d1.db.prepare("SELECT paper FROM page_text WHERE text LIKE '%nomatch%'").all();
  assert.ok(r.meta.rows_read >= PAPERS * PAGES, `read ${r.meta.rows_read}`);
});

test('per-paper reads and deletes read a handful of rows, not the whole table', async () => {
  const read = await d1.db.prepare('SELECT page, text FROM page_text WHERE paper = ? AND page BETWEEN 1 AND 3 ORDER BY page').bind('p25').all();
  assert.ok(read.meta.rows_read < 50, `read ${read.meta.rows_read}`);
  assert.equal((await firstPages(d1.db, 'p25')).length, 3);
  const del = await d1.db.prepare('DELETE FROM page_text WHERE paper = ? AND page > 0').bind('p26').run();
  // 20 rows deleted: each costs the row, its index entry and the trigger's lookups, so allow a small multiple, far below 1,000.
  assert.ok(del.meta.rows_read < 250, `delete read ${del.meta.rows_read}`);
  assert.equal((await d1.db.prepare('SELECT count(*) AS n FROM page_text WHERE paper = ?').bind('p26').first()).n, 0);
});

test('/api/indexed reads one row per paper', async () => {
  const r = await d1.db.prepare('SELECT paper FROM indexed').all();
  assert.ok(r.meta.rows_read <= PAPERS + 5, `read ${r.meta.rows_read}`);
  const ids = await indexedPapers(d1.db);
  assert.ok(ids.includes('p0') && ids.includes('p49') && !ids.includes('p26'));
});

test('indexed follows the pages: replaced keeps it, notes alone do not count, removal drops it', async () => {
  await indexPages(d1.db, 'p1', ['fresh']);
  assert.ok((await indexedPapers(d1.db)).includes('p1'));
  await removeFromIndex(d1.db, 'p0', { pdfOnly: true });
  const ids = await indexedPapers(d1.db);
  assert.ok(!ids.includes('p0'));
  assert.equal((await search(d1.db, 'notable'))[0].page, 0); // the notes row survived
  await removeFromIndex(d1.db, 'p1');
  assert.ok(!(await indexedPapers(d1.db)).includes('p1'));
  assert.equal((await search(d1.db, 'fresh')).length, 0);
});

test('search finds the right page and stays cheap per paper', async () => {
  const hits = await search(d1.db, 'uniqueterm7');
  assert.deepEqual(hits.map((h) => [h.paperId, h.page]), [['p7', 4]]);
  const r = await d1.db.prepare('SELECT t.paper FROM page_fts JOIN page_text t ON t.id = page_fts.rowid WHERE page_fts MATCH ?').bind('"uniqueterm7"*').all();
  assert.ok(r.meta.rows_read < 50, `search read ${r.meta.rows_read}`);
});

test('migration file: old pages table copies over, twice is harmless, counts match', async () => {
  const fresh = await localD1();
  try {
    await fresh.db.exec("CREATE VIRTUAL TABLE pages USING fts5(paper UNINDEXED, page UNINDEXED, text, tokenize='porter unicode61 remove_diacritics 2')");
    await fresh.db.exec("INSERT INTO pages (paper, page, text) VALUES ('a', 1, 'alpha beta'), ('a', 2, 'gamma'), ('a', 0, 'note delta'), ('b', 1, 'epsilon')");
    const sql = readFileSync(new URL('../migrations/0001_page_text.sql', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('--')).join('\n');
    const strip = (s) => s.replace(/\s+/g, ' ');
    for (const q of SCHEMA) assert.ok(strip(sql).includes(strip(q)), `migration lacks: ${q.slice(0, 60)}`);
    await fresh.db.exec(sql);
    await fresh.db.exec(sql);
    const n = async (t) => (await fresh.db.prepare(`SELECT count(*) AS n FROM ${t}`).first()).n;
    assert.equal(await n('page_text'), await n('pages'));
    assert.deepEqual((await indexedPapers(fresh.db)).sort(), ['a', 'b']);
    resetSchemaCache();
    assert.equal((await search(fresh.db, 'epsilon'))[0].paperId, 'b');
    assert.equal((await search(fresh.db, 'delta')).length, 0); // notes from before they could be private are cleared on first use
    await fresh.db.exec(readFileSync(new URL('../migrations/0002_drop_pages.sql', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('--')).join('\n'));
    assert.equal((await search(fresh.db, 'gamma'))[0].page, 2);
  } finally { await fresh.dispose(); }
});
