#!/usr/bin/env node
/**
 * Applies the Prisma schema during a build - but only from a build that is
 * allowed to change a database.
 *
 * This used to be a bare `prisma db push --skip-generate` in the build script,
 * which broke every preview deployment: DATABASE_URL is configured for the
 * Production environment only, so a build of any branch other than main aborted
 * with P1012 before `next build` ever started.
 *
 * Handing DATABASE_URL to Preview as well would be the wrong repair. There is
 * one database, and `db push` rewrites its shape to match whatever schema it is
 * handed. A preview build is by definition an UNMERGED branch, so that repair
 * would let any pushed branch reshape the live database before a human ever
 * looked at it. A dropped column does not come back.
 *
 * So: production pushes, everything else reports what it skipped and why.
 * Set DB_PUSH=1 to override, for the day a real preview database exists.
 */
import { spawnSync } from 'node:child_process'

/**
 * Pure on purpose, so the table below is a unit test rather than a deployment.
 *
 * @param {{ vercelEnv?: string, databaseUrl?: string, force?: boolean }} env
 * @returns {{ action: 'push' | 'skip' | 'fail', reason: string }}
 */
export function decide({ vercelEnv, databaseUrl, force = false }) {
  if (force) return { action: 'push', reason: 'DB_PUSH=1 was set explicitly' }

  // Not on Vercel: a developer running `npm run build` on their own machine.
  // Push unconditionally, because DATABASE_URL missing from process.env proves
  // nothing here - Prisma reads .env by itself, and .env is where it lives
  // locally. Gating on process.env would quietly stop applying local schema.
  if (!vercelEnv) return { action: 'push', reason: 'local build' }

  if (vercelEnv !== 'production') {
    return {
      action: 'skip',
      reason: `VERCEL_ENV=${vercelEnv}; only production may change the schema`,
    }
  }

  // Production with no database is not something to shrug at. The schema would
  // silently drift behind the code, and the first request for a column that was
  // never created is a 500 in front of the client rather than a red build.
  if (!databaseUrl) {
    return {
      action: 'fail',
      reason:
        'DATABASE_URL is not set for the Production build.\n' +
        '  Vercel → the panetti project → Settings → Environment Variables.\n' +
        '  Add DATABASE_URL (the Neon POOLED connection string) with the\n' +
        '  Production environment ticked, then redeploy.',
    }
  }

  return { action: 'push', reason: 'production build' }
}

/**
 * Prisma hides a whole class of changes behind `--accept-data-loss`, and only
 * some of that class can actually destroy something. Adding a unique
 * constraint cannot: it either succeeds, or it fails loudly on a duplicate
 * row. Dropping a column can, and must keep failing the build.
 *
 * This is an ALLOWLIST on purpose. A denylist of known-destructive phrasings
 * would silently start accepting whatever wording Prisma invents next, and the
 * first anyone would know of it is a column that did not come back.
 *
 * Why it exists: swapping DeliveryPromise's unique key on 2026-08-07 blocked
 * every deployment for a day. `db push` runs non-interactively in CI, so its
 * "use --accept-data-loss" prompt is not a prompt - it is a dead build, and
 * the schema change behind it was provably safe.
 *
 * @param {string} output combined stdout+stderr of the failed push
 * @returns {boolean} true only when EVERY warning is a constraint addition
 */
export function retryable(output) {
  const warnings = [...String(output).matchAll(/^\s*•\s*(.+?)\s*$/gm)].map((m) => m[1])
  // No warnings means the push died of something else - an unreachable
  // database, a malformed schema. Retrying with a data-loss flag would fail
  // again and teach the operator nothing.
  if (warnings.length === 0) return false
  return warnings.every((w) =>
    /^A (unique constraint|primary key) covering the columns .* will be added\./.test(w),
  )
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('db-push.mjs')

if (isMain) {
  const { action, reason } = decide({
    vercelEnv: process.env.VERCEL_ENV,
    databaseUrl: process.env.DATABASE_URL,
    force: process.env.DB_PUSH === '1',
  })

  if (action === 'fail') {
    console.error(`\n[db-push] ${reason}\n`)
    process.exit(1)
  }

  if (action === 'skip') {
    // Loud, not silent: a build that quietly stopped applying the schema is how
    // a missing column reaches production wearing a green tick.
    console.log(`[db-push] schema NOT applied - ${reason}`)
    process.exit(0)
  }

  console.log(`[db-push] applying the schema - ${reason}`)

  // Captured rather than inherited, because the retry decision below has to
  // read the warnings. Everything is echoed either way, so the build log looks
  // the same as it always did.
  const run = spawnSync('prisma db push --skip-generate', { shell: true, encoding: 'utf8' })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  process.stdout.write(output)

  if ((run.status ?? 1) === 0) process.exit(0)

  if (!retryable(output)) {
    console.error(
      '\n[db-push] the schema was NOT applied, and this is not a refusal we retry.\n' +
        '  Prisma only warns like this when something can actually be lost -\n' +
        '  a dropped column, a dropped table, a required column on rows that\n' +
        '  already exist. Fix the schema change, or apply it by hand against\n' +
        '  the database with a human watching.\n',
    )
    process.exit(run.status ?? 1)
  }

  // Every warning was a constraint being added. That cannot delete anything:
  // the worst it can do is fail on a duplicate, which fails the build anyway.
  console.log(
    '[db-push] every warning above is a constraint being added, which cannot\n' +
      '  destroy data - retrying once with --accept-data-loss.',
  )
  const retry = spawnSync('prisma db push --skip-generate --accept-data-loss', {
    stdio: 'inherit',
    shell: true,
  })
  process.exit(retry.status ?? 1)
}
