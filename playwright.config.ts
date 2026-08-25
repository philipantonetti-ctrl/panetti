import { defineConfig } from '@playwright/test'

// Another session may hold port 3000 with an older build; E2E_PORT keeps two
// checkouts' test runs out of each other's way.
const port = Number(process.env.E2E_PORT ?? 3000)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  globalSetup: './e2e/global-setup.ts',
  // One worker, deliberately: every spec shares the one seeded database, and
  // admin-ambassador-portal.spec MUTATES the shared admin account mid-test.
  // Parallel workers race that mutation - a concurrent sign-in lands on the
  // portal instead of the dashboard and times out hunting for admin nav.
  workers: 1,
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `npm run dev -- -p ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
