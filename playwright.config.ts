import { defineConfig, devices } from '@playwright/test';
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--no-proxy-server'] },
  },
  webServer: {
    command: process.env.E2E_PRODUCTION
      ? 'node scripts/assets.mjs && npx tsx scripts/test-production-server.ts'
      : 'node scripts/assets.mjs && npx tsx scripts/test-server.ts',
    url: 'http://127.0.0.1:4310/api/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
