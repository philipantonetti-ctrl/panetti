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
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      globals: true,
      env: {
        DATABASE_URL: env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/ecom_analytics?schema=public',
        AUTH_SECRET: env.AUTH_SECRET || 'test-secret-change-me-in-production-0123456789abcdef',
      },
    },
  }
})
