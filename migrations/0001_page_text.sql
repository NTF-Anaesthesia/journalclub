-- Moves the PDF text from the old FTS5 table `pages` to the indexed tables (page_text, page_fts, indexed). One statement
-- per line (D1 exec rule). Safe to run twice: IF NOT EXISTS on the schema, OR IGNORE on (paper, page); the triggers
-- fill page_fts and indexed. Run: wrangler d1 execute journalclub-search --remote --file migrations/0001_page_text.sql
-- Then compare SELECT count(*) FROM pages with SELECT count(*) FROM page_text before 0002_drop_pages.sql.
CREATE TABLE IF NOT EXISTS page_text (id INTEGER PRIMARY KEY, paper TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS page_text_paper_page ON page_text (paper, page);
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(text, content='page_text', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS indexed (paper TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS page_text_ai AFTER INSERT ON page_text BEGIN INSERT INTO page_fts (rowid, text) VALUES (new.id, new.text); INSERT OR IGNORE INTO indexed (paper) SELECT new.paper WHERE new.page > 0; END;
CREATE TRIGGER IF NOT EXISTS page_text_ad AFTER DELETE ON page_text BEGIN INSERT INTO page_fts (page_fts, rowid, text) VALUES ('delete', old.id, old.text); DELETE FROM indexed WHERE paper = old.paper AND NOT EXISTS (SELECT 1 FROM page_text WHERE paper = old.paper AND page > 0); END;
INSERT OR IGNORE INTO page_text (paper, page, text) SELECT paper, page, text FROM pages;
