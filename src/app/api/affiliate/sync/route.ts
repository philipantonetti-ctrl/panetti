import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllAffiliateAccounts } from '@/lib/affiliate/sync'

/** Each brand refetches its whole history; two of them can outlive the default budget. */
export const maxDuration = 60

/**
 * The "Sync now" button. The cron already asks every few hours; this asks right
 * now, six-hour throttle ignored. A broken token fails inside its own account
 * and is reported in the results, never thrown — one brand must not take the
 * other down with it.
 */
export async function POST() {
  try {
    assertAdmin(await currentUser())
    const results = await syncAllAffiliateAccounts({ force: true })
    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not sync the affiliate accounts' }, { status: 500 })
  }
}
