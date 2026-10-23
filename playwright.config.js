import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  // The 1000-paper spec loads the shared emulator heavily, so it runs on its own after the others.
  projects: [
    { name: 'app', testIgnore: /scale\.spec\.js/ },
    { name: 'scale', testMatch: /scale\.spec\.js/, dependencies: ['app'] },
  ],
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://localhost:5000', launchOptions: existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {} },
  webServer: {
    command: 'npx http-server public -p 5000 -s',
    url: 'http://localhost:5000', reuseExistingServer: true, timeout: 120000,
  },
});
