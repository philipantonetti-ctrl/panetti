import { describe, it, expect } from 'vitest'
import { decide, retryable } from './db-push.mjs'

const URL = 'postgresql://user:pw@host/db'

/**
 * Captured verbatim from the push that blocked every deploy from 2026-08-07:
 * swapping DeliveryPromise's unique from [country, effectiveFrom] to
 * [shopId, country, effectiveFrom]. Reproduced against a scratch database
 * seeded with three rows — all three survived the retry.
 */
const CONSTRAINT_ADDED = `
⚠️  There might be data loss when applying the changes:

  • A unique constraint covering the columns \`[shopId,country,effectiveFrom]\` on the table \`DeliveryPromise\` will be added. If there are existing duplicate values, this will fail.


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`

const COLUMN_DROPPED = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the column \`spend\` on the \`AdSpend\` table, which still contains 4210 non-null values.


Error: Use the --accept-data-loss flag to ignore the data loss warnings
`

const TABLE_DROPPED = `
⚠️  There might be data loss when applying the changes:

  • You are about to drop the \`AdCampaignSpend\` table, which is not empty.

`

const REQUIRED_COLUMN = `
⚠️  There might be data loss when applying the changes:

  • Added the required column \`shopId\` to the \`Order\` table without a default value. There are 937 rows in this table, it is not possible to execute this step.

`

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

/**
 * `prisma db push` refuses a whole class of changes behind one flag, and only
 * some of that class can actually destroy anything. Adding a unique constraint
 * cannot: it either succeeds or fails loudly on a duplicate. Dropping a column
 * can, and must keep failing the build.
 *
 * An ALLOWLIST, deliberately. A denylist of known-destructive phrasings would
 * silently start accepting whatever wording Prisma invents next, and the first
 * time anyone noticed would be a column that did not come back.
 */
describe('which refusals may be retried with --accept-data-loss', () => {
  it('retries a unique constraint being added — it can fail, but it cannot delete', () => {
    expect(retryable(CONSTRAINT_ADDED)).toBe(true)
  })

  it('NEVER retries a dropped column', () => {
    expect(retryable(COLUMN_DROPPED)).toBe(false)
  })

  it('NEVER retries a dropped table', () => {
    expect(retryable(TABLE_DROPPED)).toBe(false)
  })

  it('NEVER retries a required column added to a table with rows', () => {
    expect(retryable(REQUIRED_COLUMN)).toBe(false)
  })

  it('refuses when a safe warning is mixed with a destructive one', () => {
    // The dangerous case: one acceptable line must never buy a pass for the
    // line beside it. Every warning has to be safe, not merely the first.
    const mixed = CONSTRAINT_ADDED.trimEnd() + COLUMN_DROPPED
    expect(retryable(mixed)).toBe(false)
  })

  it('refuses a failure that carries no warnings at all', () => {
    // No warning means the push failed for some other reason — a bad
    // connection string, a syntax error. Retrying with a data-loss flag would
    // just fail again, having told the operator nothing.
    expect(retryable('Error: P1001 Can\'t reach database server at `host:5432`')).toBe(false)
    expect(retryable('')).toBe(false)
  })

  it('retries a primary key being added, which is the same shape of change', () => {
    expect(
      retryable(
        '⚠️  There might be data loss when applying the changes:\n\n' +
          '  • A primary key covering the columns `[id]` on the table `Shop` will be added. ' +
          'If there are existing duplicate values, this will fail.\n',
      ),
    ).toBe(true)
  })
})
