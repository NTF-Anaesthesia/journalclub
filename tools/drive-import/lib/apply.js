// The writes for one analysed PDF: paper doc (if new), the file, its page text for search, then file { pages, size }.
// Each stage is saved to the state file, so a rerun carries on where a crash stopped and never adds a paper twice.
import { readFile } from 'node:fs/promises';
import { cleanPages, PAGE_MAX, PAGES_MAX } from '../../../worker/search.js';

export const paperFields = (rec, tags, addedBy, ts) => ({
  doi: rec.doi || '', pmid: rec.pmid || '', title: rec.title, authors: (rec.authors || []).slice(0, 50),
  journal: rec.journal || '', year: rec.year || null, abstract: (rec.abstract || '').slice(0, 20000),
  ...(rec.abstract && rec.abstractSource ? { abstractSource: rec.abstractSource } : {}),
  oa: { status: 'unknown', license: null, url: null },
  tags, why: '', addedBy, addedAt: ts, changedAt: ts,
});

// Page texts as the Worker accepts them: at most PAGES_MAX pages; shrink pages until the total is within its cap.
export function indexablePages(pages) {
  let p = pages.slice(0, PAGES_MAX);
  for (const max of [PAGE_MAX, 8000, 3000, 1000]) {
    const ok = cleanPages(p.map((t) => t.slice(0, max)));
    if (ok) return ok;
  }
  return null;
}

// io: { createPaper(fields) -> id, setFile(id, {pages,size}), put(path, body, init) -> Response }
export async function applyOne(entry, rec, { pagesOf, io, tags, save }) {
  let id = rec.paperId || (rec.status === 'attach' ? rec.dupOf : null);
  if (!id) {
    id = await io.createPaper(rec, tags);
    save({ hash: rec.hash, paperId: id, stage: 'created' });
  }
  if (rec.stage === 'uploaded') return id;
  const buf = await readFile(entry.path);
  const r = await io.put(`/api/file/${id}`, buf, 'application/pdf');
  if (!r.ok) throw new Error(`file upload ${r.status}`);
  const pages = await pagesOf(entry.path);
  const body = indexablePages(pages);
  const ix = body && await io.put(`/api/index/${id}`, JSON.stringify({ pages: body }), 'application/json');
  if (body && !ix.ok) throw new Error(`index upload ${ix.status}`);
  await io.setFile(id, { pages: pages.length, size: buf.byteLength });
  save({ hash: rec.hash, paperId: id, stage: 'uploaded', status: 'done' });
  return id;
}
