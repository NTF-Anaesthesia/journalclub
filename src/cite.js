// Citations for selected papers: Vancouver for pasting, BibTeX for reference managers. Authors are stored
// "Given Family" (Crossref and PubMed lookups), so the family name is the last word.

function vancouverName(a) {
  const parts = String(a).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  const family = parts.pop();
  const initials = parts.flatMap((w) => w.split('-')).map((w) => w.replace(/[^\p{L}]/gu, '')[0] || '').join('').toUpperCase();
  return `${family} ${initials}`.trim();
}

export function vancouver(p) {
  const a = (p.authors || []).map(vancouverName).filter(Boolean);
  const names = a.length > 6 ? `${a.slice(0, 6).join(', ')}, et al.` : a.length ? `${a.join(', ')}.` : '';
  const title = String(p.title || '').trim().replace(/[.?!]?$/, (m) => m || '.');
  const src = [p.journal && `${p.journal}.`, p.year && `${p.year}.`].filter(Boolean).join(' ');
  const id = p.doi ? `doi:${p.doi}` : p.pmid ? `PMID: ${p.pmid}` : '';
  return [names, title, src, id].filter(Boolean).join(' ');
}

export const vancouverList = (papers) => papers.map((p, i) => `${i + 1}. ${vancouver(p)}`).join('\n');

const bibEsc = (s) => String(s || '').replace(/[\\{}]/g, '').replace(/([&%$#_])/g, '\\$1');

function bibAuthor(a) {
  const parts = String(a).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  const family = parts.pop();
  return `${family}, ${parts.join(' ')}`;
}

// Keys are first author's family name + year (+ a, b, … on clashes), ASCII only.
export function bibtex(papers) {
  const used = new Map();
  return papers.map((p) => {
    const fam = String((p.authors || [])[0] || 'paper').trim().split(/\s+/).pop()
      .normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase() || 'paper';
    const base = `${fam}${p.year || ''}`;
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    const key = n ? `${base}${String.fromCharCode(96 + n)}` : base;
    const f = [
      ['title', `{${bibEsc(p.title)}}`],
      (p.authors || []).length && ['author', `{${p.authors.map(bibAuthor).map(bibEsc).join(' and ')}}`],
      p.journal && ['journal', `{${bibEsc(p.journal)}}`],
      p.year && ['year', `{${p.year}}`],
      p.doi && ['doi', `{${bibEsc(p.doi)}}`],
      p.pmid && ['pmid', `{${bibEsc(p.pmid)}}`],
    ].filter(Boolean);
    return `@article{${key},\n${f.map(([k, v]) => `  ${k} = ${v}`).join(',\n')}\n}`;
  }).join('\n\n');
}
