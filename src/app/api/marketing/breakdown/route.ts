import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { rangeFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { loadBreakdown } from '@/lib/ads/breakdown'
import type { BreakdownLevel } from '@/lib/ads/types'

const LEVELS = ['campaign', 'adset', 'ad'] as const
const PROVIDERS = ['meta', 'google'] as const

/** N sequential platform calls, one per ad account, can outlive the default budget. */
export const maxDuration = 60

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const shopId = params.get('shopId')
    const level = params.get('level') ?? 'campaign'
    const provider = params.get('provider') ?? 'meta'
    // Optional: BreakdownTable.tsx sends it on every child request (the row
    // being expanded knows its own account) and omits it at campaign level on
    // purpose — see loadBreakdown for why that omission is what keeps the
    // union across a shop's accounts working.
    const accountId = params.get('accountId')

    // Validated before anything is called: a typo must not reach a platform.
    if (!shopId) return NextResponse.json({ error: 'Pick a shop' }, { status: 400 })
    if (!LEVELS.includes(level as never)) {
      return NextResponse.json({ error: 'Unknown level' }, { status: 400 })
    }
    // The drivers do not guard this themselves: level 'adset' or 'ad' with no
    // parentId would silently query the whole account instead of one campaign
    // or ad set, so it is refused here rather than passed through.
    if ((level === 'adset' || level === 'ad') && !params.get('parentId')) {
      return NextResponse.json({ error: 'Missing parentId for this level' }, { status: 400 })
    }
    if (!PROVIDERS.includes(provider as never)) {
      return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
    }

    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)

    return NextResponse.json(
      await loadBreakdown({
        shopId,
        provider: provider as (typeof PROVIDERS)[number],
        level: level as BreakdownLevel,
        ...(params.get('parentId') ? { parentId: params.get('parentId')! } : {}),
        ...(accountId ? { accountId } : {}),
        from,
        to,
      }),
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the breakdown' }, { status: 500 })
  }
}
