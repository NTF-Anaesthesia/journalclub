// Titles from file names and first-page headings, for PDFs whose DOI cannot be found. Pure functions.

// "AICM_202405 Acid-base-physiology_2023_mpaic.pdf" -> "Acid base physiology"
export function titleFromFileName(name) {
  let t = String(name || '').replace(/\.pdf$/i, '');
  t = t.replace(/^\s*AICM[\s_-]*\d{4,6}[\s_-]*/i, '').replace(/[_\s-]+\d{4}[_\s-]+mpaic$/i, '').replace(/[_\s-]mpaic$/i, '');
  t = t.replace(/_+/g, ' ');
  // A dash-joined name ("Acid-base-physiology") has no spaces; a name with spaces keeps its real hyphens ("CRASH-3").
  if (!/\s/.test(t.trim()) && (t.match(/-/g) || []).length >= 2) t = t.replace(/-/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t || 'Untitled PDF';
}

const BOILERPLATE = /(https?:|www\.|doi|©|copyright|all rights reserved|original article|review article|editorial|volume|issue|available online|downloaded from|received|accepted|pmid|issn|journal of|british journal|anaesthesia\b.*\d{4})/i;

// The first line of page 1 that reads like a title: 4-30 words, mostly letters, not a running header.
export function headingFromPage(pageText) {
  const lines = String(pageText || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15);
  for (const l of lines) {
    const words = l.split(' ');
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    if (l.length < 20 || l.length > 200 || words.length < 4 || words.length > 30) continue;
    if (letters / l.length < 0.75 || BOILERPLATE.test(l) || !/^[A-Z0-9]/.test(l)) continue;
    if (l === l.toUpperCase() && words.length > 12) continue;
    return l;
  }
  return null;
}

export function pickTitle(fileName, firstPage) {
  const heading = headingFromPage(firstPage);
  return heading ? { title: heading, from: 'heading' } : { title: titleFromFileName(fileName), from: 'filename' };
}
