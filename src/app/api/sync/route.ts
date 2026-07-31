import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { syncAllShops, syncShop } from '@/lib/woo/sync'

/**
 * Stated rather than inherited: this route relies on the platform default, and
 * a default that moves under us is exactly how the scheduled sync came to give
 * itself 60 seconds.
 */
export const maxDuration = 300

/** Matches the scheduled run, so pressing the button behaves like waiting for it. */
const SHOPS_DEADLINE_MS = 240_000

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')
    const deadline = Date.now() + SHOPS_DEADLINE_MS
    const results = shopId
      ? [await syncShop(shopId, { deadline })]
      : await syncAllShops({ deadline })

    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
