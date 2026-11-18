import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  timeout: 30000,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {baseURL: 'http://127.0.0.1:8743', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure'},
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
    {name: 'webkit-mobile', use: {...devices['iPhone 13'], defaultBrowserType: 'webkit'}},
  ],
  webServer: {
    command: 'python3 scripts/build_site.py --output dist && python3 scripts/serve_test_site.py',
    url: 'http://127.0.0.1:8743/renai/',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
