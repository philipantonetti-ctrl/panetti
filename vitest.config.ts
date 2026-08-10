import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Tests use the same one database as the app: PostgreSQL, from .env (one source
// of truth). The fallback is that same local Postgres — never a second kind of DB.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [tsconfigPaths(), react()],
    test: {
      environment: 'node',
      globals: true,
      env: {
        DATABASE_URL: env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/ecom_analytics?schema=public',
        AUTH_SECRET: env.AUTH_SECRET || 'test-secret-change-me-in-production-0123456789abcdef',
      },
      projects: [
        {
          extends: true,
          test: {
            name: 'app',
            // scripts/ too: the build's schema-push decision is logic that can break a
            // deployment, so it is tested like anything else that can.
            include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
            exclude: [
              'src/lib/{delivery,bring}/**/*.integration.test.ts',
              'src/app/api/delivery/**/*.integration.test.ts',
              'src/app/api/orders/route.test.ts',
              'src/lib/advisor/**/*.integration.test.ts',
              'src/app/api/cron/briefing/route.integration.test.ts',
            ],
          },
        },
        {
          extends: true,
          test: {
            name: 'delivery',
            // Must stay identical to the `app` project's exclude, so the two
            // partition the suite exactly. The API-route half matters as much as
            // the lib half: those tests write DeliveryPromise and the
            // DeliveryConfig singleton, which no tag can isolate.
            include: [
              'src/lib/{delivery,bring}/**/*.integration.test.ts',
              'src/app/api/delivery/**/*.integration.test.ts',
              // Not an integration-test filename, and deliberately listed anyway:
              // the Orders route test now creates a DeliveryPromise row for its
              // Delivery column. PUT /api/delivery/settings deletes EVERY promise
              // row — that is real production behaviour, since promises are
              // rewritten wholesale rather than diffed — so left in the parallel
              // `app` project this file's fixture could be wiped mid-test,
              // flipping `late` from true to false. Membership here follows the
              // state a file touches, not what it is called.
              'src/app/api/orders/route.test.ts',
              'src/lib/advisor/**/*.integration.test.ts',
              'src/app/api/cron/briefing/route.integration.test.ts',
            ],
            // These files share a fixed-id singleton, a table the settings route
            // rewrites wholesale, and a global alert query. No tag can separate
            // them; only running them one at a time can.
            fileParallelism: false,
          },
        },
      ],
    },
  }
})
