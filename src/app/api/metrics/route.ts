import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { leaderboard } from '@/lib/metrics/ambassadors'
import { dailySeries, previousRange } from '@/lib/metrics/trend'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

export async function GET(req: Request) {
  try {
    // Company-wide figures are admin-only. This is the security boundary.
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadMetricsInput({ shopIds, from, to, timezone })
    const metrics = computeMetrics(input)

    const people = await db.ambassador.findMany({
      where: { active: true },
      select: { id: true, name: true },
    })

    const top = leaderboard({
      ambassadors: people,
      orders: input.orders,
      rates: input.rates,
      displayCurrency: input.displayCurrency,
      from,
      to,
      timezone,
    })

    // The equally-long period before this one, so every figure can say which way it moved.
    const before = previousRange(from, to)
    const previous = computeMetrics(
      await loadMetricsInput({ shopIds, from: before.from, to: before.to, timezone }),
    ).total

    return NextResponse.json({
      metrics,
      previous,
      series: dailySeries(input), // revenue and profit per day, for the chart
      leaderboard: top.filter((r) => r.orders > 0).slice(0, 10),
      range: { from: from.toISOString(), to: to.toISOString() },
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load metrics' }, { status: 500 })
  }
}
