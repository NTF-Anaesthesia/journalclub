import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  // Every worker has its own emulator project and each test starts from an empty one (e2e/emu.js), so tests run in parallel.
  fullyParallel: true,
  workers: process.env.CI ? 4 : undefined,
  // CI runs the specs as parallel shards: PW_SHARD=current/total.
  shard: process.env.PW_SHARD ? { current: +process.env.PW_SHARD.split('/')[0], total: +process.env.PW_SHARD.split('/')[1] } : undefined,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:5000', launchOptions: existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {} },
  webServer: {
    command: 'npx http-server public -p 5000 -s',
    url: 'http://localhost:5000', reuseExistingServer: true, timeout: 120000,
  },
});
