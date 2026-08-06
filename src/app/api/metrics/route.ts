import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { dailySeries, previousRange } from '@/lib/metrics/trend'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(req: Request) {
  try {
    // Company-wide figures are admin-only. This is the security boundary.
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    // Both touch the database and neither depends on the other, so fire them
    // together rather than paying each round trip to Neon in series: the
    // current range, and the equally-long period before this one (so every
    // figure can say which way it moved).
    const before = previousRange(from, to)
    const [input, previousInput] = await Promise.all([
      loadMetricsInput({ shopIds, from, to, timezone }),
      loadMetricsInput({ shopIds, from: before.from, to: before.to, timezone }),
    ])

    const metrics = computeMetrics(input)
    const previous = computeMetrics(previousInput).total

    // No leaderboard here. The Dashboard's Top ambassadors card is gone, and
    // the Ambassadors page builds its own from /api/ambassadors/stats — so
    // computing one here cost every dashboard load a roster query and a pass
    // over the period's orders for a figure nothing read.
    return NextResponse.json({
      metrics,
      previous,
      series: dailySeries(input), // revenue and profit per day, for the chart
      range: { from: from.toISOString(), to: to.toISOString() },
    }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load metrics' }, { status: 500, headers: NO_STORE })
  }
}
