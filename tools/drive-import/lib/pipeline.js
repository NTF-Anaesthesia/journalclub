// The analysis of one PDF (no writes anywhere): text, identity, metadata, abstract, duplicates. Dependencies are
// passed in, so tests run on made-up text with no network.
import { enrich, findDois, findPmid } from '../../../worker/enrich.js';
import { atotwNumber } from '../../../src/doi.js';
import { normTitle } from '../../../src/dupes.js';
import { pickTitle, aiTitle } from './names.js';
import { hasText } from './pdftext.js';

export const MAX_PDF = 25 * 1024 * 1024;
export const SMALL_PDF = 50 * 1024;

// The live library, for dedupe: by DOI first, then normalised title.
export function libraryIndex(papers) {
  const byDoi = new Map(), byTitle = new Map();
  for (const p of papers) {
    if (p.doi) byDoi.set(p.doi.toLowerCase(), p);
    if (p.title) byTitle.set(normTitle(p.title), p);
  }
  return { find: (doi, title) => (doi && byDoi.get(doi.toLowerCase())) || byTitle.get(normTitle(title)) || null };
}

// entry: { path, name, size, hash }. batch: { dois: Map, titles: Map } of what earlier files in this run found.
// Returns a plain record that goes in the state file and the report (no page text).
export async function analyse(entry, { pagesOf, lib, batch, enrichFn = enrich, fetchFn, email, ai }) {
  const rec = { hash: entry.hash, file: entry.name, size: entry.size, stage: 'analysed', status: 'new', problem: '' };
  if (entry.size > MAX_PDF) return { ...rec, status: 'too-big', problem: 'over 25 MB' };
  if (entry.size < SMALL_PDF) rec.problem = 'small file (under 50 KB)';
  const pages = await pagesOf(entry.path);
  rec.pages = pages.length;
  if (!pages.length || !hasText(pages)) return { ...rec, status: 'needs-ocr', problem: 'no text layer (scanned)' };

  // No ID printed on the first pages: the title is the only way to find the paper, so a local model reads it too.
  let fallback = pickTitle(entry.name, pages[0]);
  if (ai && !findDois(pages.slice(0, 3)).length && !findPmid(pages.slice(0, 3))) {
    const t = await aiTitle(ai, entry.name, pages[0]);
    if (t) fallback = { title: t, from: 'ai-title' };
  }
  const out = await enrichFn({
    pages, fetchFn, email, ai,
    paper: { title: fallback.title, doi: '', atotw: atotwNumber(entry.name) },
  });
  const f = out.found || {};
  rec.via = out.via || fallback.from;
  rec.doi = f.doi || '';
  rec.pmid = f.pmid || '';
  rec.title = f.title || fallback.title;
  rec.authors = f.authors || [];
  rec.journal = f.journal || '';
  rec.year = f.year || null;
  rec.abstract = f.abstract || '';
  rec.abstractSource = out.abstractSource || '';
  if (!rec.abstract) rec.problem = [rec.problem, 'no abstract'].filter(Boolean).join('; ');

  const key = rec.doi ? rec.doi.toLowerCase() : normTitle(rec.title);
  if (batch.keys.has(key)) return { ...rec, status: 'dup-in-batch', dupOf: batch.keys.get(key) };
  batch.keys.set(key, entry.name);

  const hit = lib.find(rec.doi, rec.title);
  if (hit) {
    rec.dupOf = hit.id;
    rec.status = hit.hasFile ? 'in-library' : 'attach';
  }
  return rec;
}

const CSV_COLS = ['file', 'status', 'via', 'doi', 'title', 'abstractSource', 'dupOf', 'pages', 'size', 'problem'];
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function csv(recs) {
  return [CSV_COLS.join(','), ...recs.map((r) => CSV_COLS.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export function counts(recs) {
  const out = {};
  for (const r of recs) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}
