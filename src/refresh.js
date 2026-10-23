// "Refresh abstracts" (admin, from select mode in src/bulk.js): look papers up again and rewrite the bibliographic fields that changed.
import { atotwDoi } from './doi.js';

const FIELDS = ['title', 'journal', 'authors', 'abstract'];

// The identifier to look a stored paper up by: DOI, else PubMed ID, else its ATOTW number (the field, else one in its title).
export function refreshId(p) {
  return p.doi || p.pmid || (p.atotw ? `10.28923/atotw.${p.atotw}` : atotwDoi(p.title)) || null;
}

// Only the fields a lookup may change: title, journal, authors, abstract, and doi/pmid when the paper had none.
// Empty lookup values never overwrite stored ones, and neither does anything in `manual` (typed by hand in
// Edit details). A new abstract is marked as coming from a lookup (it replaces an AI summary or PDF excerpt).
// Never tags, why, file or addedBy.
export function refreshChanges(p, fresh) {
  const out = {};
  const manual = p.manual || [];
  for (const f of FIELDS) {
    const v = fresh[f];
    if (manual.includes(f) || !v || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(v) !== JSON.stringify(p[f] ?? (f === 'authors' ? [] : ''))) out[f] = v;
  }
  for (const f of ['doi', 'pmid']) if (!p[f] && fresh[f] && !manual.includes(f)) out[f] = fresh[f];
  if (out.abstract) out.abstractSource = 'lookup';
  return out;
}

// "Fill missing details": what the Worker found in the PDF (res from POST /api/enrich/<id>) may fill only what the
// paper lacks, never a field in `manual`. A file-name title is replaced only when a DOI or PubMed ID in the PDF
// matched; a looked-up abstract may replace an AI summary or PDF excerpt, nothing else. `taken`: DOIs of other papers.
export function fillChanges(p, res, taken = new Set()) {
  const f = res?.found || {};
  const manual = p.manual || [];
  const ok = (k) => !manual.includes(k);
  const out = {};
  const dupe = f.doi && taken.has(f.doi);
  const placeholder = !p.doi && !p.pmid && !(p.authors || []).length && !p.journal;
  if (ok('title') && f.title && placeholder && ['pdf-doi', 'pdf-pmid', 'atotw'].includes(res.via) && !dupe) out.title = f.title;
  if (!dupe) for (const k of ['doi', 'pmid']) if (ok(k) && !p[k] && f[k]) out[k] = f[k];
  if (ok('authors') && !(p.authors || []).length && f.authors?.length) out.authors = f.authors.slice(0, 100);
  if (ok('journal') && !p.journal && f.journal) out.journal = f.journal;
  if (ok('year') && !p.year && f.year) out.year = f.year;
  const upgrade = res.abstractSource === 'lookup' && ['ai', 'pdf'].includes(p.abstractSource);
  if (ok('abstract') && f.abstract && res.abstractSource && (!p.abstract || upgrade)) {
    out.abstract = f.abstract.slice(0, 20000);
    out.abstractSource = res.abstractSource;
  }
  return out;
}
