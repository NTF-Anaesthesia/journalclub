// The first DOI printed in a PDF's text, without trailing punctuation or an unbalanced closing bracket.
export function findDoi(text) {
  let doi = /\b10\.\d{4,9}\/[^\s"'<>]+/.exec(text || '')?.[0];
  if (!doi) return null;
  for (;;) {
    const trimmed = doi.replace(/[.,;:\]]+$/, '');
    const open = trimmed.split('(').length, close = trimmed.split(')').length;
    doi = trimmed.endsWith(')') && close > open ? trimmed.slice(0, -1) : trimmed;
    if (doi === trimmed) return doi;
  }
}

// Anaesthesia Tutorial of the Week (WFSA): DOI 10.28923/atotw.<number>. Reads "ATOTW 551" (also "ATOTW_551",
// "atotw-551", "ATOTW no. 551") from a file name or page text, or "Tutorial 551" on a page that names the series.
const ATOTW = /(?:^|[^a-z])atotw[\s_#.-]*(?:no\.?\s*)?(\d{1,4})(?!\d)/i;
const SERIES = /tutorial\s+of\s+the\s+week/i;
const TUTORIAL = /\btutorial[\s#]*(?:no\.?\s*)?(\d{2,4})(?!\d)/i;
export function atotwDoi(s) {
  const t = String(s || '');
  const n = ATOTW.exec(t)?.[1] || (SERIES.test(t) ? TUTORIAL.exec(t)?.[1] : null);
  return n && Number(n) > 0 ? `10.28923/atotw.${Number(n)}` : null;
}
