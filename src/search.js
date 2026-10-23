import MiniSearch from 'minisearch';
import { decodeEntities } from './abstract.js';

// One search document per paper (metadata, abstract, notes) and one per stored PDF page,
// so a hit inside a PDF can open at its page.
export function buildIndex(papers, notes, texts) {
  const ms = new MiniSearch({
    fields: ['title', 'authors', 'journal', 'tags', 'why', 'abstract', 'notes', 'text'],
    storeFields: ['paperId', 'page'],
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND', boost: { title: 3, tags: 2, why: 1.5 } },
  });
  const docs = [];
  for (const [id, p] of papers) {
    docs.push({
      id: `p:${id}`, paperId: id, page: null,
      title: p.title, authors: (p.authors || []).join(' '), journal: p.journal, tags: (p.tags || []).join(' '),
      why: p.why, abstract: decodeEntities(p.abstract), notes: (notes.get(id) || []).map((n) => n.text).join(' '),
    });
    (texts.get(id) || []).forEach((text, i) => { if (text) docs.push({ id: `t:${id}:${i + 1}`, paperId: id, page: i + 1, text }); });
  }
  ms.addAll(docs);
  return ms;
}

// Results grouped by paper, best first; `page` is the best-matching PDF page, if any.
export function searchPapers(ms, q) {
  const best = new Map();
  for (const r of ms.search(q)) {
    const cur = best.get(r.paperId) || { paperId: r.paperId, score: 0, page: null, pageScore: 0 };
    cur.score += r.score;
    if (r.page && r.score > cur.pageScore) { cur.page = r.page; cur.pageScore = r.score; }
    best.set(r.paperId, cur);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
