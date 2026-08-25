import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  // One worker, deliberately: every spec shares the one seeded database, and
  // admin-ambassador-portal.spec MUTATES the shared admin account mid-test.
  // Parallel workers race that mutation - a concurrent sign-in lands on the
  // portal instead of the dashboard and times out hunting for admin nav.
  workers: 1,
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
