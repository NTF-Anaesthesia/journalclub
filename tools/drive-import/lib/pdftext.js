// Per-page text with poppler's pdftotext: a form feed ends each page.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function splitPages(out) {
  const pages = String(out || '').split('\f');
  if (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
}

export async function extractPages(path) {
  const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
  return splitPages(stdout);
}

// Scanned PDFs have no text layer: under 200 letters on the first three pages.
export const hasText = (pages) => pages.slice(0, 3).join('').replace(/[^A-Za-z]/g, '').length >= 200;
