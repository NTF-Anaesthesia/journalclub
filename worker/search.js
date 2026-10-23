// PDF full-text search in D1 (binding SEARCH, database journalclub-search): one FTS5 row per PDF page,
// plus page 0 for the paper's member notes. The client sends the pages it extracted at upload; the
// Worker answers GET /api/search with paper ids, the best page and a short snippet.
//
// D1 caps a statement at 100 bound values, so rows go in 30 at a time.
const SCHEMA = "CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(paper UNINDEXED, page UNINDEXED, text, tokenize='porter unicode61 remove_diacritics 2')";
const ROWS_PER_INSERT = 30;
export const PAGE_MAX = 20000;
export const PAGES_MAX = 2000;
const TEXT_MAX = 2 * 1024 * 1024;
export const MARK = ['\u0002', '\u0003']; // snippet hit markers; the client escapes the text, then turns them into <mark>

let ready = null;
export function ensureSchema(db) {
  ready = ready || db.exec(SCHEMA).catch((e) => { ready = null; throw e; });
  return ready;
}
export const resetSchemaCache = () => { ready = null; };

function inserts(db, paperId, rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    out.push(db.prepare(`INSERT INTO pages (paper, page, text) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`)
      .bind(...chunk.flatMap(([page, text]) => [paperId, page, text])));
  }
  return out;
}

// Pages as sent by the client: a list of strings, page 1 first. Returns the cleaned list or null.
export function cleanPages(pages) {
  if (!Array.isArray(pages) || pages.length > PAGES_MAX || !pages.every((p) => typeof p === 'string')) return null;
  let total = 0;
  const out = pages.map((p) => p.replace(/\s+/g, ' ').trim().slice(0, PAGE_MAX));
  for (const p of out) total += p.length;
  return total > TEXT_MAX ? null : out;
}

// Replaces a paper's PDF pages (page >= 1); notes (page 0) stay.
export async function indexPages(db, paperId, pages) {
  await ensureSchema(db);
  const rows = pages.map((t, i) => [i + 1, t]).filter(([, t]) => t);
  await db.batch([db.prepare('DELETE FROM pages WHERE paper = ? AND page > 0').bind(paperId), ...inserts(db, paperId, rows)]);
  return rows.length;
}

// Replaces a paper's notes row (page 0) with the joined note texts.
export async function indexNotes(db, paperId, texts) {
  await ensureSchema(db);
  const text = texts.filter(Boolean).join(' • ').slice(0, PAGE_MAX);
  await db.batch([db.prepare('DELETE FROM pages WHERE paper = ? AND page = 0').bind(paperId),
    ...(text ? inserts(db, paperId, [[0, text]]) : [])]);
}

export async function removeFromIndex(db, paperId, { pdfOnly = false } = {}) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM pages WHERE paper = ?${pdfOnly ? ' AND page > 0' : ''}`).bind(paperId).run();
}

// Each word becomes a quoted prefix term; FTS5 ANDs them. Returns null when there is nothing to search.
export function ftsQuery(q) {
  const words = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const terms = [...new Set(words)].filter((w) => w.length > 1 || /\d/.test(w)).slice(0, 8);
  return terms.length ? terms.map((w) => `"${w}"*`).join(' ') : null;
}

// Best rows first; one hit per paper, with its best PDF page (a notes-only hit has page 0).
export async function search(db, q, limit = 100) {
  const match = ftsQuery(q);
  if (!match) return [];
  await ensureSchema(db);
  const { results } = await db.prepare(
    `SELECT paper, page, snippet(pages, 2, ?, ?, '…', 16) AS snippet FROM pages WHERE pages MATCH ? ORDER BY bm25(pages) LIMIT 400`,
  ).bind(MARK[0], MARK[1], match).all();
  const hits = new Map();
  for (const r of results) {
    const page = Number(r.page);
    const h = hits.get(r.paper);
    if (!h) hits.set(r.paper, { paperId: r.paper, page, snippet: r.snippet });
    else if (h.page === 0 && page > 0) Object.assign(h, { page, snippet: r.snippet });
  }
  return [...hits.values()].slice(0, limit);
}
