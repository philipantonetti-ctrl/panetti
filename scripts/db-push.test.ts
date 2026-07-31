import { describe, it, expect } from 'vitest'
import { decide } from './db-push.mjs'

const URL = 'postgresql://user:pw@host/db'

describe('which builds may change the schema', () => {
  it('pushes from a production build that has a database', () => {
    expect(decide({ vercelEnv: 'production', databaseUrl: URL }).action).toBe('push')
  })

  it('FAILS a production build with no database rather than deploying past it', () => {
    // The alternative is a green build whose schema silently drifts behind the
    // code, and a 500 in front of the client on the first request for a column
    // that was never created.
    const { action, reason } = decide({ vercelEnv: 'production', databaseUrl: undefined })
    expect(action).toBe('fail')
    expect(reason).toContain('Environment Variables')
  })

  it('skips a preview build even when a database IS reachable', () => {
    // The whole point. One database, and `db push` rewrites its shape to match
    // whatever schema it is handed — so an unmerged branch must never be the
    // thing holding the pen.
    expect(decide({ vercelEnv: 'preview', databaseUrl: URL }).action).toBe('skip')
  })

  it('skips a preview build with no database, which is the bug that broke deploys', () => {
    const { action, reason } = decide({ vercelEnv: 'preview', databaseUrl: undefined })
    expect(action).toBe('skip')
    expect(reason).toContain('preview')
  })

  it('skips the development environment', () => {
    expect(decide({ vercelEnv: 'development', databaseUrl: URL }).action).toBe('skip')
  })

  it('pushes from a local build, which is how a developer applies their own schema', () => {
    expect(decide({ vercelEnv: undefined, databaseUrl: URL }).action).toBe('push')
  })

  it('still pushes locally when DATABASE_URL is absent from process.env', () => {
    // Locally the URL lives in .env, which Prisma reads for itself and node
    // does not. Gating on process.env here would silently stop applying schema
    // on every developer machine — the exact failure mode this script exists
    // to prevent, moved one environment to the left.
    expect(decide({ vercelEnv: undefined, databaseUrl: undefined }).action).toBe('push')
  })

  it('lets DB_PUSH=1 override, for the day a real preview database exists', () => {
    expect(decide({ vercelEnv: 'preview', databaseUrl: URL, force: true }).action).toBe('push')
  })

  it('treats an empty DATABASE_URL as absent, not as a connection string', () => {
    expect(decide({ vercelEnv: 'production', databaseUrl: '' }).action).toBe('fail')
  })
})
