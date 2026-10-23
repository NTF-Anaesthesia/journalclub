import MiniSearch from 'minisearch';
import { decodeEntities } from './abstract.js';

// Metadata only (title, authors, journal, tags, why, abstract), built on the phone over the cached catalogue.
// PDF pages and notes are searched by the Worker (GET /api/search); mergeHits joins the two.
export function buildIndex(papers) {
  const ms = new MiniSearch({
    fields: ['title', 'authors', 'journal', 'tags', 'why', 'abstract', 'atotw'],
    storeFields: [],
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'AND', boost: { title: 3, tags: 2, why: 1.5 } },
  });
  ms.addAll([...papers].map(([id, p]) => indexDoc(id, p)));
  return ms;
}

const indexDoc = (id, p) => ({
  id, title: p.title, authors: (p.authors || []).join(' '), journal: p.journal, tags: (p.tags || []).join(' '),
  why: p.why, abstract: decodeEntities(p.abstract), atotw: p.atotw ? `ATOTW ${p.atotw} No. ${p.atotw}` : '',
});

// Keeps the index in step with a changed or removed paper without rebuilding it.
export function updateIndex(ms, id, p) {
  if (ms.has(id)) ms.discard(id);
  if (p) ms.add(indexDoc(id, p));
}

// Results best first: { paperId, page, snippet }.
// `at(id)` is when the paper was last discussed: it breaks ties between equally relevant hits (newest first).
export function searchPapers(ms, q, at = () => 0) {
  const key = (r) => Math.round(r.score * 1e6);
  return ms.search(q).map((r, i) => ({ r, i })).sort((a, b) => key(b.r) - key(a.r) || at(b.r.id) - at(a.r.id) || a.i - b.i)
    .map(({ r }) => ({ paperId: r.id, page: null, snippet: null }));
}

// Metadata hits first, in their order, taking the server's page and snippet when it found the paper too;
// then papers found only in their PDF text or notes. `server` hits: { paperId, page (0 = notes), snippet }.
export function mergeHits(local, server, has = () => true) {
  const byId = new Map(server.map((h) => [h.paperId, h]));
  const out = local.map((h) => ({ ...h, ...(byId.get(h.paperId) || {}) }));
  const seen = new Set(out.map((h) => h.paperId));
  for (const h of server) if (!seen.has(h.paperId) && has(h.paperId)) out.push(h);
  return out.filter((h) => has(h.paperId));
}
