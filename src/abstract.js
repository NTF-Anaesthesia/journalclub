// Abstract text: decode HTML/XML entities, and split into labelled sections for the paper page.
// Shared by the Worker (lookups) and the app (abstracts stored before the decoder knew hex entities).

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ',
  ndash: '–', mdash: '—', minus: '−', hellip: '…', middot: '·', bull: '•', deg: '°', micro: 'µ', plusmn: '±',
  times: '×', divide: '÷', le: '≤', ge: '≥', ne: '≠', asymp: '≈', sim: '∼', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', permil: '‰',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', infin: '∞', sup2: '²', sup3: '³', frac12: '½', frac14: '¼',
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

// One pass, so "&amp;#x2264;" stays the literal text "&#x2264;" (as written by the source).
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] !== '#') return NAMED[e] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
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
