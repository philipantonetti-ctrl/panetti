import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { dailySeries, previousRange, sameRangeLastYear } from '@/lib/metrics/trend'
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

    // All three touch the database and none depends on another, so fire them
    // together rather than paying each round trip to Neon in series: the
    // current range, the equally-long period before it, and the same dates
    // one year earlier (so every figure can say which way it moved, both
    // against last month and year on year - the client asked for both).
    const before = previousRange(from, to)
    const lastYearRange = sameRangeLastYear(from, to)
    const [input, previousInput, lastYearInput] = await Promise.all([
      loadMetricsInput({ shopIds, from, to, timezone }),
      loadMetricsInput({ shopIds, from: before.from, to: before.to, timezone }),
      loadMetricsInput({ shopIds, from: lastYearRange.from, to: lastYearRange.to, timezone }),
    ])

    const metrics = computeMetrics(input)
    const previous = computeMetrics(previousInput).total
    const lastYear = computeMetrics(lastYearInput).total
    const iso = (r: { from: Date; to: Date }) => ({ from: r.from.toISOString(), to: r.to.toISOString() })

    // No leaderboard here. The Dashboard's Top ambassadors card is gone, and
    // the Ambassadors page builds its own from /api/ambassadors/stats — so
    // computing one here cost every dashboard load a roster query and a pass
    // over the period's orders for a figure nothing read.
    return NextResponse.json({
      metrics,
      previous,
      lastYear,
      series: dailySeries(input), // revenue and profit per day, for the chart
      range: iso({ from, to }),
      // The ranges behind the two comparisons, so the page can say exactly
      // what each percentage is against instead of guessing from the preset.
      previousRange: iso(before),
      lastYearRange: iso(lastYearRange),
    }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load metrics' }, { status: 500, headers: NO_STORE })
  }
}
