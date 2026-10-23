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
