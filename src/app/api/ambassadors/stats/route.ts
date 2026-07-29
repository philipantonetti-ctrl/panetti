import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { leaderboard } from '@/lib/metrics/ambassadors'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

/** Staff-only numbers, but never company-wide ones: no caching either way. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Ambassador statistics for staff: the leaderboard and the shop options for
 * its filter — and nothing else. Revenue, profit, series and spend are never
 * computed here, so there is nothing to hide.
 */
export async function GET(req: Request) {
  try {
    assertStaff(await currentUser())
    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const [input, roster, shopOptions] = await Promise.all([
      loadMetricsInput({ shopIds, from, to, timezone }),
      // Same roster rule as the dashboard: codes say who belongs where.
      db.ambassador.findMany({
        where: {
          active: true,
          ...(shopIds ? { codes: { some: { shopId: { in: shopIds } } } } : {}),
        },
        select: {
          id: true,
          name: true,
          codes: { select: { shop: { select: { name: true } } } },
        },
      }),
      db.shop.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ])
    const people = roster.map((person) => ({
      id: person.id,
      name: person.name,
      shops: [...new Set(person.codes.map((c) => c.shop.name))].sort(),
    }))
    const top = leaderboard({
      ambassadors: people,
      orders: input.orders,
      rates: input.rates,
      displayCurrency: input.displayCurrency,
      from,
      to,
      timezone,
    })

    return NextResponse.json(
      {
        leaderboard: top,
        shopOptions,
        displayCurrency: input.displayCurrency,
        range: { from: from.toISOString(), to: to.toISOString() },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load ambassador statistics' },
      { status: 500, headers: NO_STORE },
    )
  }
}
