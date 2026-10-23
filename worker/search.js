// PDF full-text search in D1 (binding SEARCH, database journalclub-search): one row per PDF page in page_text,
// plus page 0 for the paper's member notes, with an external-content FTS5 index (page_fts) over it. page_text is
// indexed on (paper, page) so a per-paper read or delete touches only that paper's rows; `indexed` holds one row
// per paper with PDF pages, so /api/indexed reads one row per paper. Triggers keep both in step with page_text.
// The Worker answers GET /api/search with paper ids, the best page and a short snippet.
//
// D1 caps a statement at 100 bound values, so rows go in 30 at a time. D1 exec() runs one statement per line, so
// the schema goes through batch() instead.
const TOKENIZE = "tokenize='porter unicode61 remove_diacritics 2'";
export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS page_text (id INTEGER PRIMARY KEY, paper TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS page_text_paper_page ON page_text (paper, page)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(text, content='page_text', content_rowid='id', ${TOKENIZE})`,
  'CREATE TABLE IF NOT EXISTS indexed (paper TEXT PRIMARY KEY) WITHOUT ROWID',
  "CREATE TRIGGER IF NOT EXISTS page_text_ai AFTER INSERT ON page_text BEGIN INSERT INTO page_fts (rowid, text) VALUES (new.id, new.text); INSERT OR IGNORE INTO indexed (paper) SELECT new.paper WHERE new.page > 0; END",
  "CREATE TRIGGER IF NOT EXISTS page_text_ad AFTER DELETE ON page_text BEGIN INSERT INTO page_fts (page_fts, rowid, text) VALUES ('delete', old.id, old.text); DELETE FROM indexed WHERE paper = old.paper AND NOT EXISTS (SELECT 1 FROM page_text WHERE paper = old.paper AND page > 0); END",
];
const ROWS_PER_INSERT = 30;
export const PAGE_MAX = 20000;
export const PAGES_MAX = 2000;
const TEXT_MAX = 2 * 1024 * 1024;
export const MARK = ['\u0002', '\u0003']; // snippet hit markers; the client escapes the text, then turns them into <mark>

let ready = null;
export function ensureSchema(db) {
  ready = ready || db.batch(SCHEMA.map((q) => db.prepare(q))).catch((e) => { ready = null; throw e; });
  return ready;
}
export const resetSchemaCache = () => { ready = null; };

function inserts(db, paperId, rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    out.push(db.prepare(`INSERT INTO page_text (paper, page, text) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`)
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
  await db.batch([db.prepare('DELETE FROM page_text WHERE paper = ? AND page > 0').bind(paperId), ...inserts(db, paperId, rows)]);
  return rows.length;
}

// Replaces a paper's notes row (page 0) with the joined note texts.
export async function indexNotes(db, paperId, texts) {
  await ensureSchema(db);
  const text = texts.filter(Boolean).join(' • ').slice(0, PAGE_MAX);
  await db.batch([db.prepare('DELETE FROM page_text WHERE paper = ? AND page = 0').bind(paperId),
    ...(text ? inserts(db, paperId, [[0, text]]) : [])]);
}

export async function removeFromIndex(db, paperId, { pdfOnly = false } = {}) {
  await ensureSchema(db);
  await db.prepare(`DELETE FROM page_text WHERE paper = ?${pdfOnly ? ' AND page > 0' : ''}`).bind(paperId).run();
}

// Paper ids with at least one PDF page indexed (the library's "PDF not indexed" filter is the papers with a PDF not in here).
export async function indexedPapers(db) {
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT paper FROM indexed').all();
  return results.map((r) => r.paper);
}

// The text of a paper's first PDF pages (1..n), page 1 first; [] when it is not indexed.
export async function firstPages(db, paperId, n = 3) {
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT page, text FROM page_text WHERE paper = ? AND page BETWEEN 1 AND ? ORDER BY page').bind(paperId, n).all();
  return results.map((r) => r.text);
}

// The library's search syntax, for FTS5: each word a quoted prefix term (ANDed), "a phrase" an exact phrase,
// a OR b either, -word / -"a phrase" left out. Anything else in the box is plain text. Null when there is nothing to
// search (only excluded words, or no words).
export function ftsQuery(q) {
  const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const keep = (w) => w.length > 1 || /\d/.test(w);
  const groups = [], not = [], seen = new Set();
  let n = 0, join = false;
  for (const m of String(q || '').matchAll(/(-?)"([^"]+)"|(\S+)/g)) {
    if (n >= 8) break;
    if (m[3] === 'OR' && groups.length) { join = true; continue; }
    const neg = m[1] === '-' || (m[3] || '').startsWith('-');
    const ws = words(m[2] ?? m[3]).filter(keep);
    if (!ws.length) { join = false; continue; }
    const terms = m[2] != null ? [`"${ws.join(' ')}"`] : ws.map((w) => `"${w}"*`);
    if (neg) { not.push(terms[0]); join = false; continue; }
    for (const t of terms) {
      if (seen.has(t) || n >= 8) continue;
      seen.add(t); n++;
      if (join) groups.at(-1).push(t); else groups.push([t]);
      join = false;
    }
  }
  if (!groups.length) return null;
  const pos = groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0])).join(' ');
  return not.length ? `(${pos}) NOT (${not.slice(0, 4).join(' OR ')})` : pos;
}

// Best rows first; one hit per paper, with its best PDF page (a notes-only hit has page 0).
export async function search(db, q, limit = 100) {
  const match = ftsQuery(q);
  if (!match) return [];
  await ensureSchema(db);
  const { results } = await db.prepare(
    `SELECT t.paper, t.page, snippet(page_fts, 0, ?, ?, '…', 16) AS snippet FROM page_fts JOIN page_text t ON t.id = page_fts.rowid
     WHERE page_fts MATCH ? ORDER BY bm25(page_fts) LIMIT 400`,
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
