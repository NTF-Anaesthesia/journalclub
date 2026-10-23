// "Fill missing details" (admin): find what a paper lacks from its own PDF text, already in D1 (pages 1..3).
// Order: an ID printed in the PDF (DOI, PubMed ID, ATOTW number) looked up as usual; else a strict title search;
// then the PDF's own abstract/summary section; then, only when asked, a machine-written abstract (stored with abstractSource 'ai', not shown as such).
// Pure functions plus one orchestrator that takes fetch (and the AI binding) as arguments, so tests run on text.
import { lookup, parseId } from './lookup.js';
import { atotwDoi } from '../src/doi.js';
import { normTitle, similarity } from '../src/dupes.js';
import { decodeEntities } from '../src/abstract.js';

const CROSSREF_SEARCH = 'https://api.crossref.org/works?rows=3&select=DOI,title&query.bibliographic=';
export const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_DOIS = 2;
const MIN_ABSTRACT = 150;
const MAX_ABSTRACT = 3000;

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// DOIs printed in the text, first page first. A DOI broken across lines ends in "-" or "/" before the break.
export function findDois(pages) {
  const out = [];
  pages.forEach((text) => {
    const toks = squash(text).split(' ');
    for (let i = 0; i < toks.length; i++) {
      const at = toks[i].search(/10\.\d{4,9}\//);
      if (at < 0) continue;
      let s = toks[i].slice(at);
      while (/[-/]$/.test(s) && toks[i + 1]) s += toks[++i];
      const doi = parseId(s)?.doi;
      if (doi && !out.includes(doi)) out.push(doi);
    }
  });
  return out;
}

export function findPmid(pages) {
  return /\bPMID:?\s*(\d{6,9})\b/i.exec(pages.join(' '))?.[1] || null;
}

// The words of a title that are in the text: a looked-up record is only accepted when its title is printed
// in the PDF's first pages (a DOI cited in a reference list belongs to another paper).
export function titleInText(title, text) {
  const words = normWords(title);
  if (words.length < 3) return false;
  const have = new Set(normWords(text));
  return words.filter((w) => have.has(w)).length / words.length >= 0.8;
}
const normWords = (s) => (String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || []);

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

// Anaesthesia Tutorial of the Week PDFs: journal name and year from page 1 (the series has no DOI before about 525).
export function atotwDetails(text) {
  const t = squash(text);
  if (!/tutorial\s+of\s+the\s+week/i.test(t)) return null;
  const year = Number(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]
    || new RegExp(`\\b${MONTH}\\s+(\\d{4})\\b`, 'i').exec(t)?.[1]) || null;
  return { journal: 'Anaesthesia Tutorial of the Week', year };
}

const HEADS = /\b(Abstract|ABSTRACT|Summary|SUMMARY|Key [Pp]oints|KEY POINTS|Key [Mm]essages|KEY MESSAGES|Highlights|HIGHLIGHTS)\s*[:.\-–—]?\s+(?=[A-Z0-9])/g;
// Headings are written Capitalised or in capitals; the same word in running prose is not a stop.
const END = /\b(?:Key\s*[Ww]ords?|KEY\s*WORDS?|Keywords?|KEYWORDS?|References|REFERENCES|Introduction(?!\s*:)|INTRODUCTION|Learning\s+[Oo]bjectives|LEARNING\s+OBJECTIVES|Correspondence|CORRESPONDENCE|Declarations?|DECLARATIONS?|Conflicts?\s+of\s+[Ii]nterest|Copyright|COPYRIGHT|Before\s+reading|BEFORE\s+READING|Questions?|QUESTIONS?)\b|©/;

// The PDF's own abstract, summary or key points: from the heading to the next heading, 150-3000 characters.
// Text in D1 has its whitespace collapsed, so this works on one line.
export function extractAbstract(pages) {
  const text = squash(pages.slice(0, 2).join(' '));
  let best = null;
  for (const m of text.matchAll(HEADS)) {
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const stop = rest.slice(60).search(END);
    let body = (stop < 0 ? rest.slice(0, MAX_ABSTRACT) : rest.slice(0, stop + 60)).trim();
    if (stop < 0 && body.length >= MAX_ABSTRACT) body = body.replace(/[^.!?]*$/, '').trim();
    if (body.length < MIN_ABSTRACT) continue;
    if (body.length > MAX_ABSTRACT) body = body.slice(0, MAX_ABSTRACT).replace(/[^.!?]*$/, '').trim();
    // A line that is mostly a heading list ("Introduction Methods Results") is not prose.
    if (body.split(/[.!?]\s/).length < 2 && body.length < 400) continue;
    best = { heading: m[1], text: decodeEntities(body) };
    break;
  }
  return best;
}

async function titleSearch(title, fetchFn) {
  if (normWords(title).length < 4 || /\.pdf$/i.test(title)) return null;
  const r = await fetchFn(CROSSREF_SEARCH + encodeURIComponent(title), { headers: { Accept: 'application/json' } }).catch(() => null);
  const items = r?.ok ? (await r.json().catch(() => null))?.message?.items || [] : [];
  const want = normTitle(title);
  const hit = items.find((it) => it.DOI && similarity(want, normTitle((it.title || [])[0])) >= 0.9);
  return hit ? String(hit.DOI).toLowerCase() : null;
}

const SYSTEM_PROMPT = [
  'You write the abstract of a published article or tutorial for a journal club library.',
  'Output only the abstract text: one or two paragraphs of about 150 to 250 words, in plain prose.',
  'Cover the topic, the key points and any practical recommendations.',
  'Be factual and neutral, and use only the text given; add nothing from outside it.',
  'No introduction, no heading, no title, no bullet points, no quotation marks, and never mention that this is a summary or an abstract.',
  'If the text is not an article or tutorial, reply with the single word NONE.',
].join(' ');

// Models still open with "Here is a 2-3 sentence summary of the article:", "Summary:" or wrap the text in quotes.
const LEAD_IN = /^(?:(?:here(?:'|’)?s|here is|here are|this is|below is|the following is)\b[^\n:]{0,160}?\b(?:summary|abstract|overview)\b[^\n:]{0,160}(?::|\n|$)|(?:abstract|summary|overview|tl;?dr)[ \t]*(?::|\n))\s*/i;
const QUOTES = /^["“”'‘’]+|["“”'‘’]+$/g;

export function cleanSummary(raw) {
  let s = String(raw ?? '').replace(/\r/g, '').replace(/\*\*|__|^#+\s*/gm, '').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(LEAD_IN, '').replace(QUOTES, '').trim();
    if (s === before) break;
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Cost note: ~1.7k input and ~350 output tokens per paper on llama-3.3-70b-instruct-fp8-fast (about $0.13 per 100 papers).
export async function aiSummary(ai, text) {
  const body = squash(text).slice(0, 6000);
  if (!ai || body.length < 400) return null;
  const out = await ai.run(AI_MODEL, {
    max_tokens: 500,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: body },
    ],
  }).catch(() => null);
  const raw = out?.response ?? out?.choices?.[0]?.message?.content;
  const s = cleanSummary(raw);
  return s.length >= 60 && !/^none\b/i.test(s) ? s.slice(0, 2400) : null;
}

// pages: strings, page 1 first. paper: the stored { title, doi, pmid, abstract }. opts.ai: Workers AI binding or null.
export async function enrich({ pages, paper = {}, fetchFn, email, ai = null }) {
  const head = pages.slice(0, 3);
  const text12 = head.slice(0, 2).join(' ');
  const out = { found: {}, abstractSource: null, via: null, hasText: head.some((t) => t.trim()) };
  if (!out.hasText) return out;

  const take = (rec, via) => {
    out.found = { doi: rec.doi || '', pmid: rec.pmid || '', title: rec.title || '', authors: rec.authors || [],
      journal: rec.journal || '', year: rec.year || null, abstract: rec.abstract || '' };
    out.via = via;
    if (rec.abstract) out.abstractSource = 'lookup';
  };
  const tryId = async (id, via) => {
    const rec = await lookup(id, fetchFn, email);
    if (rec.error || !titleInText(rec.title, text12)) return false;
    take(rec, via);
    return true;
  };

  let done = false;
  for (const doi of [paper.doi, ...findDois(head)].filter(Boolean).slice(0, MAX_DOIS)) {
    if (await tryId(doi, 'pdf-doi')) { done = true; break; }
  }
  const pmid = findPmid(head);
  if (!done && pmid) done = await tryId(pmid, 'pdf-pmid');
  if (!done) {
    const atotw = atotwDoi(head[0]) || atotwDoi(paper.title);
    if (atotw) done = await tryId(atotw, 'atotw');
  }
  if (!done) {
    const doi = await titleSearch(paper.title, fetchFn);
    if (doi) done = await tryId(doi, 'title');
  }

  const hand = atotwDetails(head[0]);
  if (hand) {
    if (!out.found.journal) out.found.journal = hand.journal;
    if (!out.found.year && hand.year) out.found.year = hand.year;
  }
  if (!out.found.abstract) {
    const ab = extractAbstract(head);
    if (ab) { out.found.abstract = ab.text; out.abstractSource = 'pdf'; }
  }
  if (!out.found.abstract && ai) {
    const s = await aiSummary(ai, head.join(' '));
    if (s) { out.found.abstract = s; out.abstractSource = 'ai'; }
  }
  return out;
}
