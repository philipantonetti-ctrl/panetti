import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Tests use the same one database as the app: PostgreSQL, from .env (one source
// of truth). The fallback is that same local Postgres — never a second kind of DB.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    // Resolve `@/*` with Vite's own resolver rather than the plugin below.
    //
    // vite-tsconfig-paths resolves through `unrs-resolver`, which ships a
    // NATIVE binary installed by a postinstall script. Where that script is
    // blocked — a sandbox, a locked-down CI, `npm ci --ignore-scripts` — the
    // binary is absent and the plugin then fails to resolve `@/*` SILENTLY:
    // every test importing `@/lib/...` dies with "Cannot find package", which
    // reads as a broken repo rather than a missing binary. Vite 8 resolves
    // tsconfig paths natively with no binary at all, and its own deprecation
    // warning recommends exactly this option, so it is both the fix and the
    // direction of travel. The plugin stays as a harmless no-op to keep the
    // change to one line.
    resolve: { tsconfigPaths: true },
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
              'src/lib/{delivery,bring,dhl}/**/*.integration.test.ts',
              'src/app/api/delivery/**/*.integration.test.ts',
              'src/app/api/orders/route.test.ts',
              'src/lib/advisor/**/*.integration.test.ts',
              'src/app/api/cron/briefing/route.integration.test.ts',
              'src/lib/data/load.test.ts',
              'src/lib/data/load.integration.test.ts',
              'src/lib/inventory/load.test.ts',
            ],
          },
        },
        {
          extends: true,
          test: {
            name: 'setting',
            // load.test.ts WRITES the real workspace Setting singleton
            // (displayCurrency) mid-test; load.integration.test.ts READS it
            // through getSetting() and asserts it defaults to USD. Run in the
            // `app` project's normal parallelism, the two race on one
            // un-taggable row — same shape of problem the `delivery` project
            // below already solves, and the same fix: run them one at a time.
            include: ['src/lib/data/load.test.ts', 'src/lib/data/load.integration.test.ts'],
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'delivery',
            // Together with the `setting` project's own include list just above,
            // this must stay exactly the `app` project's exclude list — the
            // three projects partition the suite exactly, with no file run
            // twice and none skipped. The API-route half matters as much as
            // the lib half: those tests write DeliveryPromise and the
            // DeliveryConfig singleton, which no tag can isolate.
            include: [
              'src/lib/{delivery,bring,dhl}/**/*.integration.test.ts',
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
              // Shop.stockSource is workspace-wide: the moment ANY shop carries
              // it, every caller of loadInventory is scoped to that shop's
              // catalogue. This file flags shops mid-test, and the advisor
              // collector above now reads the inventory too — so left in the
              // parallel `app` project, its flag could empty the rows the
              // briefing's fixture is asserting on. Membership follows the state
              // a file touches, not what it is called.
              'src/lib/inventory/load.test.ts',
            ],
            // These files share a fixed-id singleton, a table the settings route
            // rewrites wholesale, a global alert query and the stock-source flag.
            // No tag can separate them; only running them one at a time can.
            fileParallelism: false,
          },
        },
      ],
    },
  }
})
