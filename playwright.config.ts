import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ux',
  fullyParallel: true,
  workers: 2,
  timeout: 45_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${process.env.TRACEROOST_UX_PORT ?? 4310}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-light',
      use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
    },
    { name: 'desktop-dark', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
    {
      name: 'mobile-light',
      use: {
        viewport: { width: 390, height: 844 },
        colorScheme: 'light',
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'mobile-dark',
      use: {
        viewport: { width: 390, height: 844 },
        colorScheme: 'dark',
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'node demo/run-ts.js tests/ux/serve.ts',
    url: `http://127.0.0.1:${process.env.TRACEROOST_UX_PORT ?? 4310}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
