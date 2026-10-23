// Titles from file names and first-page headings, for PDFs whose DOI cannot be found. Pure functions, except aiTitle.
import { titleInText } from '../../../worker/enrich.js';

const SERIES = /^\s*AICM[\s_-]*\d{4,6}[\s_-]*/i;

// "AICM_202405 Acid-base-physiology_2023_mpaic.pdf" -> "Acid base physiology"
export function titleFromFileName(name) {
  let t = String(name || '').replace(/\.pdf$/i, '');
  t = t.replace(SERIES, '').replace(/[_\s-]+\d{4}[_\s-]+(mpaic|Anaesthesia\b.*)$/i, '').replace(/[_\s-]mpaic$/i, '');
  t = t.replace(/_+/g, ' ');
  // A dash-joined name ("Acid-base-physiology") has no spaces; a name with spaces keeps its real hyphens ("CRASH-3").
  if (!/\s/.test(t.trim()) && (t.match(/-/g) || []).length >= 2) t = t.replace(/-{2,}/g, ': ').replace(/-/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t || 'Untitled PDF';
}

const BOILERPLATE = /(https?:|www\.|doi|©|copyright|all rights reserved|original article|review article|editorial|volume|issue|available online|downloaded from|received|accepted|pmid|issn|journal of|british journal|anaesthesia\b.*\d{4}|attribution|correspondence|should be able to)/i;
const AFFILIATION = /\b(University|Hospital|School of|Department|Institute|Faculty)\b/;
const FIGURE = /^(Fig(ure)?\.?|Table)\s*\d/i;
// A side box that pdftotext puts on the same line as the title.
const SIDE_BOX = /\s+(Learning objectives|After reading this article)\b.*$/i;
// Words a title never starts with but a wrapped second line often does.
const CONTINUES = /^(and|or|of|for|with|to|by|versus|vs)\b/i;
const OPEN_END = /\b(and|or|of|for|with|to|by|in|on|the|a|an|from|versus|vs)$/i;

const clean = (l) => l.replace(/\s+/g, ' ').trim();
const wordsOf = (l) => l.split(' ').filter(Boolean);
const lettersShare = (l) => (l.match(/[A-Za-z]/g) || []).length / l.length;

function titleLike(l, { cut = false } = {}) {
  const words = wordsOf(l);
  if (l.length < (cut ? 8 : 20) || l.length > 200 || words.length < (cut ? 2 : 4) || words.length > 30) return false;
  if (lettersShare(l) < 0.75 || BOILERPLATE.test(l) || AFFILIATION.test(l) || FIGURE.test(l)) return false;
  if (!/^[A-Z0-9]/.test(l) || CONTINUES.test(l)) return false;
  return !(l === l.toUpperCase() && words.length > 25);
}

// A wrapped title goes on when the next line starts lower case or with "and", "of" ..., or this line ends open.
function joinWrapped(lines, i) {
  let t = lines[i];
  for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
    const next = lines[j].replace(SIDE_BOX, '');
    const goesOn = /^[a-z]/.test(next) || CONTINUES.test(next) || OPEN_END.test(t);
    if (!goesOn || !next || lettersShare(next) < 0.75 || BOILERPLATE.test(next) || AFFILIATION.test(next)) break;
    if (wordsOf(t).length + wordsOf(next).length > 35) break;
    t = `${t} ${next}`;
    if (SIDE_BOX.test(lines[j])) break;
  }
  return t.replace(/[\s,;:-]+$/, '');
}

// An all-capitals title reads better in sentence case.
const sentenceCase = (t) => (t === t.toUpperCase() && /[A-Z]{4}/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t);

// The first line of page 1 that reads like a title (4-30 words, mostly letters, not a running header, an author's
// affiliation or a figure caption), with its wrapped next lines and without a side box on the same line.
export function headingFromPage(pageText) {
  const lines = String(pageText || '').split(/\r?\n/).map(clean).filter(Boolean).slice(0, 15);
  for (let i = 0; i < lines.length; i++) {
    const cut = SIDE_BOX.test(lines[i]);
    const l = lines[i].replace(SIDE_BOX, '');
    if (!titleLike(l, { cut })) continue;
    return sentenceCase(cut ? l : joinWrapped(lines, i));
  }
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Series file names (AICM) hold the whole title but are often cut short: drop a cut last word (only the start of a
// word printed on page 1) and a dangling "and", "of" ....
function seriesTitle(fileName, page) {
  const words = wordsOf(titleFromFileName(fileName));
  const have = norm(page).split(' ');
  const last = norm(words[words.length - 1]);
  if (words.length > 2 && !have.includes(last) && have.some((w) => w.length > last.length && w.startsWith(last))) words.pop();
  while (words.length > 2 && OPEN_END.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

export function pickTitle(fileName, firstPage) {
  const heading = headingFromPage(firstPage);
  if (SERIES.test(String(fileName || ''))) {
    const named = seriesTitle(fileName, firstPage);
    if (heading && norm(heading).startsWith(norm(named)) && norm(heading).length > norm(named).length) {
      return { title: heading, from: 'heading' };
    }
    return { title: named, from: 'filename' };
  }
  return heading ? { title: heading, from: 'heading' } : { title: titleFromFileName(fileName), from: 'filename' };
}

const TITLE_PROMPT = [
  'You are given the file name and the text of page 1 of a PDF from a medical library.',
  'Reply with the full title of the article or tutorial exactly as printed on the page, on one line, and nothing else.',
  'Join a title that wraps over several lines. Leave out author names, journal names, section labels and side boxes.',
  'If the page has no article title, reply with the single word NONE.',
].join(' ');

// The title as a local model reads it from page 1; kept only when its words are printed on the page.
export async function aiTitle(ai, fileName, firstPage) {
  const page = String(firstPage || '').slice(0, 3000);
  if (!ai || page.trim().length < 100) return null;
  const out = await ai.run('title', {
    max_tokens: 80,
    temperature: 0,
    messages: [{ role: 'system', content: TITLE_PROMPT }, { role: 'user', content: `File name: ${fileName}\n\nPage 1:\n${page}` }],
  }).catch(() => null);
  const t = clean(String(out?.response || '').split('\n').find((l) => l.trim()) || '')
    .replace(/^title:\s*/i, '').replace(/^["“'*]+|["”'*.]+$/g, '').trim();
  const n = wordsOf(t).length;
  if (!t || /^none\b/i.test(t) || n < 3 || n > 40 || !titleInText(t, page)) return null;
  return sentenceCase(t);
}
