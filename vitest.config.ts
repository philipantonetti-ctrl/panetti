import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Tests follow the same DATABASE_URL as the app (from .env), so there is one
// source of truth for the connection string. Fallback keeps a bare checkout working.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [tsconfigPaths(), react()],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      globals: true,
      env: {
        DATABASE_URL: env.DATABASE_URL || 'file:./dev.db',
        AUTH_SECRET: env.AUTH_SECRET || 'test-secret-change-me-in-production-0123456789abcdef',
      },
    },
  }
})
