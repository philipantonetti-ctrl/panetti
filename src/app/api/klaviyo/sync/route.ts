import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncKlaviyo } from '@/lib/klaviyo/sync'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** A year of campaigns in one report request; the budget is time, not calls. */
export const maxDuration = 60

/** The settings page's "Sync now": everything arrives by itself; this just asks Klaviyo right now. */
export async function POST() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json(await syncKlaviyo({ force: true }), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500, headers: NO_STORE })
  }
}
