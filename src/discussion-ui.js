// Discussion form pieces: the admin's field editor and the rendered form people fill in.
import { TYPES, normalizeFields, answerText, missingRequired } from './discussion.js';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'field';

// Admin editor: add, remove, reorder and rename fields, help text, required, list max and choice options.
export function fieldEditor(c, fields, onSave, saveLabel = 'Save form') {
  let rows = JSON.parse(JSON.stringify(fields));
  const form = c.el('<form class="stack fed"><ol class="list" id="fed-rows"></ol><button type="button" class="link" id="fed-add">Add field</button><button class="primary">' + c.esc(saveLabel) + '</button><p class="muted" id="fed-msg"></p></form>');
  const list = form.querySelector('#fed-rows');
  const draw = () => {
    list.replaceChildren();
    rows.forEach((f, i) => {
      const li = c.el(`<li class="stack"><label>Label <input data-k="label" maxlength="120" value="${c.esc(f.label)}"></label>
        <label>Help text <input data-k="help" maxlength="300" value="${c.esc(f.help || '')}"></label>
        <label>Type <select data-k="type">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${f.type === 'list' ? `<label>Max items <input data-k="max" type="number" min="1" max="10" value="${f.max || 3}"></label>` : ''}
        ${f.type === 'choice' ? `<label>Options (one per line) <textarea data-k="options" rows="3">${c.esc((f.options || []).join('\n'))}</textarea></label>
          <label><input data-k="note" type="checkbox" ${f.note ? 'checked' : ''}> Add a one-line “why”</label>` : ''}
        <label><input data-k="required" type="checkbox" ${f.required ? 'checked' : ''}> Required</label>
        <span class="actions"></span></li>`);
      li.querySelectorAll('[data-k]').forEach((inp) => {
        inp.onchange = () => {
          const k = inp.dataset.k;
          f[k] = inp.type === 'checkbox' ? inp.checked : k === 'options' ? inp.value.split('\n') : inp.value;
          if (k === 'type') draw();
        };
      });
      const act = li.querySelector('.actions');
      const btn = (t, label, fn) => { const b = c.el(`<button type="button" class="link" aria-label="${label}">${t}</button>`); b.onclick = fn; act.append(b); };
      if (i > 0) btn('↑', `Move ${c.esc(f.label)} up`, () => { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); });
      if (i < rows.length - 1) btn('↓', `Move ${c.esc(f.label)} down`, () => { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; draw(); });
      btn('Remove', `Remove ${c.esc(f.label)}`, () => { rows.splice(i, 1); draw(); });
      list.append(li);
    });
  };
  draw();
  form.querySelector('#fed-add').onclick = () => { rows.push({ id: `f${Date.now().toString(36)}`, label: 'New field', help: '', type: 'short' }); draw(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const next = normalizeFields(rows.map((f) => ({ ...f, id: f.id || slug(f.label) })));
    const msg = form.querySelector('#fed-msg');
    try { await onSave(next); msg.textContent = 'Saved.'; rows = JSON.parse(JSON.stringify(next)); draw(); }
    catch { msg.textContent = 'Could not save.'; }
  };
  return form;
}

// The form people fill in: one input per field. form.read() gives { answers, missing } for the page to save.
export function discussionForm(c, fields, answers) {
  const a = answers || {};
  const form = c.el('<form class="stack dform"><h2>Discussion</h2><div id="dfields" class="stack"></div></form>');
  const host = form.querySelector('#dfields');
  fields.forEach((f) => {
    const id = `d-${f.id}`;
    const help = f.help ? `<span class="muted">${c.esc(f.help)}</span>` : '';
    const label = `${c.esc(f.label)}${f.required ? ' *' : ''}`;
    let w;
    if (f.type === 'short') w = c.el(`<label>${label} ${help}<input id="${id}" maxlength="300"></label>`);
    else if (f.type === 'long') w = c.el(`<label>${label} ${help}<textarea id="${id}" rows="5" maxlength="4000"></textarea></label>`);
    else if (f.type === 'list') w = c.el(`<label>${label} ${help}<span class="muted">Max ${f.max || 3}, one per line</span><textarea id="${id}" rows="${Math.min(f.max || 3, 6)}" maxlength="1500"></textarea></label>`);
    else w = c.el(`<div><label>${label} ${help}<select id="${id}"><option value="">—</option>${(f.options || []).map((o) => `<option>${c.esc(o)}</option>`).join('')}</select></label>
      ${f.note ? `<label>Why? <input id="${id}~note" maxlength="300"></label>` : ''}</div>`);
    host.append(w);
    const set = (sel, v) => { const n = w.querySelector(sel) || (w.matches(sel) ? w : null); if (n) n.value = v ?? ''; };
    if (f.type === 'list') set(`#${CSS.escape(id)}`, (Array.isArray(a[f.id]) ? a[f.id] : String(a[f.id] || '').split('\n')).join('\n'));
    else set(`#${CSS.escape(id)}`, a[f.id]);
    if (f.note) set(`#${CSS.escape(id + '~note')}`, a[`${f.id}~note`]);
  });
  form.read = () => {
    const out = {};
    for (const f of fields) {
      const v = form.querySelector(`#${CSS.escape(`d-${f.id}`)}`).value.trim();
      if (f.type === 'list') out[f.id] = v.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, f.max || 3);
      else out[f.id] = v;
      if (f.note) out[`${f.id}~note`] = form.querySelector(`#${CSS.escape(`d-${f.id}~note`)}`).value.trim();
    }
    return { answers: out, missing: missingRequired(fields, out) };
  };
  return form;
}

// Read-only view of a saved discussion, using the labels it was filled with.
export function discussionView(c, fields, answers) {
  const box = c.el('<div></div>');
  fields.forEach((f) => {
    const t = answerText(f, answers);
    if (!t) return;
    const body = f.type === 'list'
      ? `<ul>${t.split(' | ').map((x) => `<li>${c.esc(x)}</li>`).join('')}</ul>` : `<p class="abstract">${c.esc(t)}</p>`;
    box.append(c.el(`<div><h3>${c.esc(f.label)}</h3>${body}</div>`));
  });
  return box;
}
