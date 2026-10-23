// A local D1 (workerd SQLite with FTS5, through wrangler) for Worker tests. persist: false keeps nothing on disk.
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { resetSchemaCache } from '../worker/search.js';

export async function localD1() {
  const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('./wrangler.test.jsonc', import.meta.url)), persist: false });
  resetSchemaCache();
  return { db: proxy.env.SEARCH, dispose: () => proxy.dispose() };
}
