import { readdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, basename } from 'node:path';

// "--folder DIR=tag": the optional tag goes on every paper from that folder.
export function parseFolderArg(arg) {
  const at = arg.lastIndexOf('=');
  return at > 0 ? { dir: arg.slice(0, at), tag: arg.slice(at + 1) } : { dir: arg, tag: '' };
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

export const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

// Every PDF under the folders, sorted, each with its size, hash and the folder's tag.
export async function scan(folders) {
  const out = [];
  for (const { dir, tag } of folders) {
    for (const path of (await walk(dir)).sort()) {
      out.push({ path, name: basename(path), rel: relative(dir, path), folder: basename(dir), tag, size: (await stat(path)).size, hash: await sha256(path) });
    }
  }
  return out;
}
