import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { leaderboard } from '@/lib/metrics/ambassadors'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { db } from '@/lib/db'

export async function GET(req: Request) {
  try {
    // Company-wide figures are admin-only. This is the security boundary.
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { from, to } = rangeFromQuery(params)
    const shopIds = shopIdsFromQuery(params)

    const input = await loadMetricsInput({ shopIds, from, to })
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
    })

    return NextResponse.json({
      metrics,
      leaderboard: top.filter((r) => r.orders > 0).slice(0, 10),
      range: { from: from.toISOString(), to: to.toISOString() },
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load metrics' }, { status: 500 })
  }
}
