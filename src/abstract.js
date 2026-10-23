// Abstract text: decode HTML/XML entities, and split into labelled sections for the paper page.
// Shared by the Worker (lookups) and the app (abstracts stored before the decoder knew hex entities).

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ',
  ndash: '–', mdash: '—', minus: '−', hellip: '…', middot: '·', bull: '•', deg: '°', micro: 'µ', plusmn: '±',
  times: '×', divide: '÷', le: '≤', ge: '≥', ne: '≠', asymp: '≈', sim: '∼', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', permil: '‰',
  rarr: '→', rArr: '⇒', hArr: '⇔', lowast: '∗', sdot: '⋅', prop: '∝', sum: '∑', radic: '√', part: '∂', isin: '∈',
  and: '∧', or: '∨', cap: '∩', cup: '∪', equiv: '≡', there4: '∴', loz: '◊', check: '✓', cross: '✗', hyphen: '‐', dash: '‐',
  shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', lrm: '', rlm: '', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', cent: '¢', pound: '£',
  euro: '€', yen: '¥', half: '½', sup1: '¹', acute: '´', uml: '¨', cedil: '¸', macr: '¯', not: '¬', brvbar: '¦', curren: '¤',
  agrave: 'à', acirc: 'â', atilde: 'ã', ecirc: 'ê', euml: 'ë', igrave: 'ì', icirc: 'î', iuml: 'ï', ograve: 'ò', ocirc: 'ô',
  otilde: 'õ', ugrave: 'ù', ucirc: 'û', yacute: 'ý', yuml: 'ÿ', Eacute: 'É', Aacute: 'Á', Oacute: 'Ó', Ccedil: 'Ç', Oslash: 'Ø',
  Aring: 'Å', AElig: 'Æ', aelig: 'æ', oelig: 'œ', OElig: 'Œ', scaron: 'š', Scaron: 'Š', thetasym: 'ϑ', piv: 'ϖ', sigmaf: 'ς', larr: '←', uarr: '↑', darr: '↓', harr: '↔', infin: '∞', sup2: '²', sup3: '³', frac12: '½', frac14: '¼',
  frac34: '¾', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', ccedil: 'ç', oslash: 'ø', aring: 'å',
};
'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'
  .split(' ').forEach((n, i) => {
    const code = 0x3b1 + i + (i >= 17 ? 1 : 0); // skip final sigma (U+03C2)
    NAMED[n] = String.fromCodePoint(code);
    NAMED[n[0].toUpperCase() + n.slice(1)] = String.fromCodePoint(code - 0x20);
  });

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎' };
const DOUBLE = /&amp;(#[xX][0-9a-fA-F]+;|#\d+;|[a-zA-Z][a-zA-Z0-9]*;)/g;
// Soft hyphen, zero-width characters, BOM and control characters (not tab or newline): invisible, but they break search.
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const codePoint = (n, m) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m);

// Entities decoded once, after undoing double encoding ("&amp;#x2264;" from some Crossref deposits);
// then invisible characters dropped and accents composed (NFC) so search matches what people type.
export function decodeEntities(s) {
  return String(s ?? '').replace(DOUBLE, '&$1')
    .replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
      if (e[0] !== '#') return NAMED[e] ?? m;
      return codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)), m);
    })
    .replace(INVISIBLE, '').normalize('NFC');
}

// XML/HTML fragment (PubMed, Crossref JATS) -> plain text on one line. Superscripts and subscripts become
// Unicode where every character has one ("10<sup>9</sup>/L" -> "10⁹/L", not "109/L"); other numeric
// exponents as "^(-3.5)"; anything else (footnote marks, ®) as plain text;
// block tags become spaces so words either side don't run together.
export function xmlToText(s) {
  const script = (map, mark) => (_, tag, t) => {
    const raw = t.replace(/<[^>]+>/g, '').trim();
    const x = decodeEntities(raw);
    if (x && [...x].every((ch) => map[ch])) return [...x].map((ch) => map[ch]).join('');
    return mark && /^[-−+]?[\d.,·]+$/.test(x) ? `^(${raw})` : raw; // still encoded: decoded after the tags are gone
  };
  const text = String(s ?? '')
    .replace(/<((?:jats:)?sup)\b[^>]*>([\s\S]*?)<\/\1>/g, script(SUP, true))
    .replace(/<((?:jats:)?(?:sub|inf))\b[^>]*>([\s\S]*?)<\/\1>/g, script(SUB, false))
    .replace(/<\/?(?:[a-z]+:)?(?:p|br|div|li|list|list-item|sec|title|tr|td)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

// Papers saved before the decoder knew hex entities: clean the shown fields when read.
export function cleanPaper(p) {
  if (!p) return p;
  return { ...p, title: decodeEntities(p.title), journal: decodeEntities(p.journal),
    authors: (p.authors || []).map(decodeEntities) };
}

// A line-start label ("BACKGROUND: ", or PubMed's "Trial registration: "), or an all-caps header
// inside the text that follows a sentence end ("... trial. METHODS: We ..."). Only before a colon.
const LINE_LABEL = /^([A-Za-z][A-Za-z ,&/()-]{1,58}[A-Za-z)]):\s+/;
const CAPS = /^[A-Z][A-Z ,&/()-]*[A-Z)]$/;
const INLINE = /(^|[.!?)\]]\s+)([A-Z][A-Z ,&/-]*[A-Z]):\s+/g;
const letters = (s) => s.replace(/[^A-Za-z]/g, '').length;

// -> [{ label, text }], label '' for text before the first header.
export function abstractSections(raw) {
  const text = decodeEntities(raw).replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let rest = line;
    let label = '';
    const m = LINE_LABEL.exec(line);
    if (m && (CAPS.test(m[1]) ? letters(m[1]) >= 3 : lines.length > 1 && m[1].split(' ').length <= 5)) {
      label = m[1];
      rest = line.slice(m[0].length);
    }
    let at = 0;
    for (const h of rest.matchAll(INLINE)) {
      if (letters(h[2]) < 4) continue;
      const cut = h.index + h[1].length;
      if (label || rest.slice(at, cut).trim()) out.push({ label, text: rest.slice(at, cut).trim() });
      label = h[2];
      at = h.index + h[0].length;
    }
    out.push({ label, text: rest.slice(at).trim() });
  }
  return out;
}
