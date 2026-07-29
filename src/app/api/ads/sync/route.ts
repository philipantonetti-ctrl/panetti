import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllAdAccounts } from '@/lib/ads/sync'

/** A few accounts re-fetching 35 days each can outlive the default budget. */
export const maxDuration = 60

/**
 * The "Sync now" button. Everything arrives by itself a few times a day; this
 * just asks the platforms right now, throttle ignored.
 */
export async function POST() {
  try {
    assertAdmin(await currentUser())
    const results = await syncAllAdAccounts({ force: true })
    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not sync the ad accounts' }, { status: 500 })
  }
}
