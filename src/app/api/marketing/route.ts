import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { dailySeries } from '@/lib/metrics/trend'
import { buildRateTable } from '@/lib/metrics/fx'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { ensureRates, loadRates } from '@/lib/fx/rates'
import { buildMarketing } from '@/lib/ads/marketing'
import { utcDay } from '@/lib/dates'
import { db } from '@/lib/db'
import { getSetting } from '@/lib/settings'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    // The order side reuses the dashboard's own loader and engine, so orders
    // and gross revenue here mean exactly what they mean one tab over.
    const input = await loadMetricsInput({ shopIds, from, to, timezone })
    const scopeIds = input.shops.map((s) => s.id)

    const [accounts, connectedCount] = await Promise.all([
      db.adAccount.findMany({
        where: { active: true, shopId: { in: scopeIds } },
        select: { id: true, shopId: true, provider: true, currency: true, dailyBudget: true },
      }),
      db.adAccount.count({ where: { active: true } }),
    ])

    // An ad account may bill in a currency no shop trades in; top up its rates
    // before converting. Best-effort: convert() falls back to the nearest
    // earlier rate, so a provider outage only makes figures approximate.
    const extra = [...new Set(accounts.map((a) => a.currency))].filter(
      (c) => c !== input.displayCurrency,
    )
    if (extra.length) {
      try {
        await ensureRates(from, to, extra)
      } catch {
        // Rates stay as they were.
      }
    }
    const rates = extra.length ? buildRateTable(await loadRates()) : input.rates

    const spend = await db.adSpend.findMany({
      where: {
        accountId: { in: accounts.map((a) => a.id) },
        date: { gte: utcDay(from), lte: utcDay(to) },
      },
      select: {
        accountId: true,
        date: true,
        spend: true,
        impressions: true,
        clicks: true,
        linkClicks: true,
        conversions: true,
        conversionValue: true,
        videoViews3s: true,
        thruplays: true,
      },
    })

    const engine = computeMetrics(input)
    const result = buildMarketing({ accounts, spend, engine, series: dailySeries(input), rates, to })

    return NextResponse.json(
      {
        ...result,
        connected: connectedCount > 0,
        range: { from: from.toISOString(), to: to.toISOString() },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not load marketing metrics' },
      { status: 500, headers: NO_STORE },
    )
  }
}
