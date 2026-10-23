// "Refresh abstracts" (admin, from select mode in src/bulk.js): look papers up again and rewrite the bibliographic fields that changed.
import { atotwDoi } from './doi.js';

const FIELDS = ['title', 'journal', 'authors', 'abstract'];

// The identifier to look a stored paper up by: DOI, else PubMed ID, else an ATOTW number in its title.
export function refreshId(p) {
  return p.doi || p.pmid || atotwDoi(p.title) || null;
}

// Only the fields a lookup may change: title, journal, authors, abstract, and doi/pmid when the paper had none.
// Empty lookup values never overwrite stored ones. Never tags, why, file or addedBy.
export function refreshChanges(p, fresh) {
  const out = {};
  for (const f of FIELDS) {
    const v = fresh[f];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(v) !== JSON.stringify(p[f] ?? (f === 'authors' ? [] : ''))) out[f] = v;
  }
  for (const f of ['doi', 'pmid']) if (!p[f] && fresh[f]) out[f] = fresh[f];
  return out;
}
