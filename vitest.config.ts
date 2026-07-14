import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    env: {
      DATABASE_URL: 'file:./dev.db',
      AUTH_SECRET: 'test-secret-change-me-in-production-0123456789abcdef',
    },
  },
})
