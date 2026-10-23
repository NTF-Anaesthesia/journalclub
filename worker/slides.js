// Session slides in the private R2 bucket: the original file (PDF or PowerPoint) and, for PowerPoint, a PDF copy
// made by CloudConvert (secret CLOUDCONVERT_KEY). A pasted link is accepted only if the Worker can pull the file
// itself, so every session keeps its own copy.

export const MAX_SLIDES = 50 * 1024 * 1024;
const CC = 'https://api.cloudconvert.com/v2/jobs';
const CC_WAIT = 'https://sync.api.cloudconvert.com/v2/jobs/';
const TYPES = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
};

// Recognises the file by its first bytes, not its name: PDF, PowerPoint 2007+ (a zip holding ppt/) or old .ppt.
export function slideKind(buf) {
  const b = new Uint8Array(buf);
  const ascii = (from, n) => String.fromCharCode(...b.subarray(from, from + n));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    // The zip's directory sits at the end; small files are read whole.
    const dec = (part) => new TextDecoder('latin1').decode(part);
    const has = dec(b.subarray(0, 65536)).includes('ppt/') || dec(b.subarray(Math.max(0, b.length - 262144))).includes('ppt/presentation.xml');
    return has ? 'pptx' : null;
  }
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((x, i) => b[i] === x)) return 'ppt';
  return null;
}

// Turns a share link into direct download URLs. Google Slides exports its own PDF, so no conversion is needed there.
export function pullUrls(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const gs = /^\/presentation\/d\/([\w-]+)/.exec(u.pathname);
  if (u.hostname === 'docs.google.com' && gs) {
    const base = `https://docs.google.com/presentation/d/${gs[1]}/export`;
    return { file: `${base}/pptx`, pdf: `${base}/pdf`, name: 'slides.pptx' };
  }
  const gd = /^\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] || (u.pathname === '/open' && u.searchParams.get('id'));
  if (u.hostname === 'drive.google.com' && gd) {
    return { file: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(gd)}` };
  }
  if (/(^|\.)dropbox\.com$/.test(u.hostname)) { u.searchParams.delete('dl'); u.searchParams.set('dl', '1'); }
  else if (/(^|\.)(sharepoint\.com|onedrive\.live\.com|1drv\.ms)$/.test(u.hostname)) u.searchParams.set('download', '1');
  return { file: u.toString() };
}

const nameFrom = (res, url) => {
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'slides';
};

export async function pull(url, fetchFn) {
  const res = await fetchFn(url, { redirect: 'follow' }).catch(() => null);
  if (!res || !res.ok) return null;
  if (Number(res.headers.get('Content-Length') || 0) > MAX_SLIDES) return { tooBig: true };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_SLIDES) return { tooBig: true };
  return { buf, name: nameFrom(res, url) };
}

// PowerPoint to PDF through CloudConvert: upload, convert, wait, fetch the result. Returns the PDF bytes or null.
export async function convertToPdf(buf, kind, key, fetchFn) {
  if (!key) return null;
  const auth = { Authorization: `Bearer ${key}` };
  const job = await fetchFn(CC, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks: {
      up: { operation: 'import/upload' },
      cv: { operation: 'convert', input: 'up', input_format: kind, output_format: 'pdf' },
      out: { operation: 'export/url', input: 'cv' },
    } }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const form = job?.data?.tasks?.find((t) => t.name === 'up')?.result?.form;
  if (!form) return null;
  const fd = new FormData();
  Object.entries(form.parameters || {}).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([buf], { type: TYPES[kind] }), `slides.${kind}`);
  const up = await fetchFn(form.url, { method: 'POST', body: fd }).catch(() => null);
  if (!up || up.status >= 400) return null;
  const done = await fetchFn(CC_WAIT + job.data.id, { headers: auth }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const fileUrl = done?.data?.status === 'finished' && done.data.tasks.find((t) => t.name === 'out')?.result?.files?.[0]?.url;
  if (!fileUrl) return null;
  const pdf = await fetchFn(fileUrl).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  return pdf && slideKind(pdf) === 'pdf' ? pdf : null;
}

const keys = (sid) => ({ orig: `slides/${sid}/original`, pdf: `slides/${sid}/pdf` });
const cleanName = (n, kind) => {
  const base = String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 150) || 'slides';
  return base.toLowerCase().endsWith('.' + kind) ? base : `${base.replace(/\.(pdf|pptx?|key)$/i, '')}.${kind}`;
};

// Stores the file (and a PDF copy for PowerPoint). `pdfBuf` is a ready PDF from the source, if it gave one.
export async function storeSlides(env, sid, uid, buf, name, fetchFn, pdfBuf = null) {
  const kind = slideKind(buf);
  if (!kind) return { status: 415, body: { error: 'Not a PDF or PowerPoint file' } };
  const k = keys(sid);
  const fileName = cleanName(name, kind);
  await Promise.all([env.FILES.delete(k.orig), env.FILES.delete(k.pdf)]);
  let pdf = kind === 'pdf' ? buf : (pdfBuf && slideKind(pdfBuf) === 'pdf' ? pdfBuf : null);
  if (kind !== 'pdf') {
    await env.FILES.put(k.orig, buf, { httpMetadata: { contentType: TYPES[kind] }, customMetadata: { uploadedBy: uid, name: fileName } });
    pdf = pdf || await convertToPdf(buf, kind, env.CLOUDCONVERT_KEY, fetchFn);
  }
  if (pdf) {
    await env.FILES.put(k.pdf, pdf, { httpMetadata: { contentType: TYPES.pdf },
      customMetadata: { uploadedBy: uid, name: cleanName(fileName.replace(/\.pptx?$/i, ''), 'pdf') } });
  }
  const out = { name: fileName, size: buf.byteLength, kind, pdf: !!pdf };
  if (!pdf) out.warning = 'Saved the PowerPoint, but the PDF copy could not be made. Try again later.';
  return { status: 200, body: out };
}

export async function serveSlides(env, sid, which) {
  const k = keys(sid);
  const obj = await env.FILES.get(which === 'pdf' ? k.pdf : k.orig);
  if (!obj) return new Response(JSON.stringify({ error: 'No file' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const name = obj.customMetadata?.name || (which === 'pdf' ? 'slides.pdf' : 'slides');
  return new Response(obj.body, { headers: {
    'Content-Type': obj.httpMetadata?.contentType || TYPES.pdf, 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${which === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  } });
}

export const deleteSlides = (env, sid) => { const k = keys(sid); return Promise.all([env.FILES.delete(k.orig), env.FILES.delete(k.pdf)]); };
