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
            exclude: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'delivery',
            include: ['src/lib/{delivery,bring}/**/*.integration.test.ts'],
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
