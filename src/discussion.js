// Discussion form logic: template fields, saved answers with their own label copy, join window, exports. No Firebase here, so it is unit-tested.
export const TYPES = { short: 'Short text', long: 'Long text', list: 'List', choice: 'Single choice' };

export const DEFAULT_FIELDS = [
  { id: 'takehome', label: 'Take-home points', help: 'Up to three, one per line.', type: 'list', max: 3, required: true },
  { id: 'practice', label: 'Would this change our practice?', help: '', type: 'choice', options: ['Yes', 'No', 'Maybe'], note: true, required: true },
  { id: 'critique', label: 'Critique: strengths and flaws', help: '', type: 'long' },
  { id: 'open', label: 'Open questions / follow-up', help: '', type: 'long' },
];

export const DEFAULT_PROMPT = 'Your take-home point';
export const DEFAULT_TIME = '16:00';

const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// A template as the admin edits it: only known types, unique ids, bounded sizes.
export function normalizeFields(raw) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    const label = clean(f?.label, 120);
    if (!label || !TYPES[f?.type]) continue;
    let id = clean(f.id, 40).replace(/[^a-z0-9_-]/gi, '') || `f${out.length + 1}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    const o = { id, label, help: clean(f.help, 300), type: f.type };
    if (f.required) o.required = true;
    if (f.type === 'list') o.max = Math.min(Math.max(parseInt(f.max, 10) || 3, 1), 10);
    if (f.type === 'choice') {
      o.options = (Array.isArray(f.options) ? f.options : []).map((x) => clean(x, 60)).filter(Boolean).slice(0, 10);
      if (!o.options.length) o.options = ['Yes', 'No'];
      if (f.note) o.note = true;
    }
    out.push(o);
  }
  return out;
}

// The copy of the form kept with a filled discussion, so old sessions read correctly after the template changes.
export const snapshot = (fields) => normalizeFields(fields).map(({ id, label, type, max, options, note }) =>
  ({ id, label, type, ...(max ? { max } : {}), ...(options ? { options } : {}), ...(note ? { note } : {}) }));

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);

// The presenter's take-home points on a session (the discussion field `takehome`), as a list of lines.
export const takeHomePoints = (s) => asList(s?.discussion?.answers?.takehome);

// Members' points, most agreed first (ties: newest first). `plus` lists the uids who agree.
export function rankPoints(points, now = Date.now()) {
  const ms = (p) => (p.updatedAt?.toMillis ? p.updatedAt.toMillis() : now);
  return [...points].sort((a, b) => (b.plus?.length || 0) - (a.plus?.length || 0) || ms(b) - ms(a));
}

// "A, B, C et al." for a paper's author list.
export const authorsShort = (a = []) => (a.length > 3 ? `${a.slice(0, 3).join(', ')} et al.` : a.join(', '));

// What one field's answer reads as in text, Markdown and CSV.
export function answerText(f, answers) {
  const v = answers?.[f.id];
  if (f.type === 'list') return asList(v).join(' | ');
  if (f.type === 'choice') {
    const note = String(answers?.[`${f.id}~note`] || '').trim();
    return [String(v || '').trim(), note].filter(Boolean).join(' — ');
  }
  return String(v || '').trim();
}

// The admin's override for this session wins; then the copy the discussion was filled with; then the current template.
export const sessionFields = (s, template) => (s.template?.length ? s.template : s.discussion?.fields?.length ? s.discussion.fields : template);

export function missingRequired(fields, answers) {
  return fields.filter((f) => f.required && !answerText(f, answers)).map((f) => f.label);
}

export function startMillis(s, clubTime) {
  const [h, m] = String(s.time || clubTime || DEFAULT_TIME).split(':').map(Number);
  const d = new Date(s.date.toMillis());
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}
// The Join button shows from 15 minutes before the start until 2 hours after.
export const inJoinWindow = (start, now) => now >= start - 15 * 60000 && now <= start + 2 * 3600000;

const dayStr = (ts) => { const d = ts.toDate(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function sessionMarkdown(s, template, points = []) {
  const fields = sessionFields(s, template);
  const a = s.discussion?.answers || {};
  const out = [`# Journal club ${dayStr(s.date)}`, '', `**Paper:** ${s.paperTitle}`, `**Presenter:** ${s.presenterName || '—'}`];
  if (s.coordinatorName) out.push(`**Coordinator:** ${s.coordinatorName}`);
  if (s.summary) out.push('', '## Summary', s.summary);
  for (const f of fields) {
    const t = answerText(f, a);
    if (!t) continue;
    out.push('', `## ${f.label}`);
    if (f.type === 'list') asList(a[f.id]).forEach((x) => out.push(`- ${x}`)); else out.push(t);
  }
  if (points.length) { out.push('', '## Members\' points'); points.forEach((p) => out.push(`- ${p.text} (${p.name || 'member'})`)); }
  return out.join('\n') + '\n';
}

// Spreadsheet formulas in text cells are defused with a leading apostrophe.
const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

// One row per session; one column per field label, in order of first appearance across sessions (older templates keep their own columns).
export function csvExport(sessions, template, pointsBySession = {}) {
  const labels = [];
  const rows = sessions.map((s) => {
    const byLabel = {};
    for (const f of sessionFields(s, template)) {
      const t = answerText(f, s.discussion?.answers);
      if (!labels.includes(f.label)) labels.push(f.label);
      byLabel[f.label] = t;
    }
    return { s, byLabel };
  });
  const head = ['Date', 'Paper', 'Presenter', 'Coordinator', 'Summary', ...labels, "Members' points"];
  const lines = [head.map(cell).join(',')];
  for (const { s, byLabel } of rows) {
    const pts = (pointsBySession[s.id] || []).map((p) => p.text).join(' | ');
    lines.push([dayStr(s.date), s.paperTitle, s.presenterName, s.coordinatorName || '', s.summary || '',
      ...labels.map((l) => byLabel[l] || ''), pts].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
