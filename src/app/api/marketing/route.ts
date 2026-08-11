import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { loadMetricsInput } from '@/lib/data/load'
import { computeMetrics } from '@/lib/metrics'
import { dailySeries } from '@/lib/metrics/trend'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { buildMarketing } from '@/lib/ads/marketing'
import { buildSpendCheck } from '@/lib/ads/spend-check'
import {
  accountIdsForShops,
  accountSpendRows,
  unassignedCampaignCount,
  hasPartialSplitAccounts,
} from '@/lib/ads/attribution'
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
    const platform = params.get('platform')

    // The order side reuses the dashboard's own loader and engine, so orders
    // and gross revenue here mean exactly what they mean one tab over.
    const input = await loadMetricsInput({ shopIds, from, to, timezone })
    const scopeIds = input.shops.map((s) => s.id)

    // A whole account is in scope on its own shopId; a split account is in
    // scope when one of ITS CAMPAIGNS resolves into scope, which can happen
    // even while the account's own default shop is filtered out. Filtering
    // this query on the account's shopId alone would silently drop that
    // account's in-scope campaigns — the same bug attributedSpend's callers
    // already avoid.
    const ids = await accountIdsForShops(scopeIds)
    const [accounts, connectedCount] = await Promise.all([
      db.adAccount.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, shopId: true, provider: true, currency: true, dailyBudget: true,
          name: true, active: true, lastSyncAt: true, lastError: true,
        },
      }),
      db.adAccount.count({ where: { active: true } }),
    ])

    // Validated against the providers actually connected. A typo must not read
    // as a legitimate zero — the same reason google.ts refuses to treat an
    // unparseable response as an empty one.
    if (platform && !accounts.some((a) => a.provider === platform)) {
      return NextResponse.json(
        { error: 'Unknown ad platform' },
        { status: 400, headers: NO_STORE },
      )
    }
    // One scoped list feeds every surface — totals, chart, tables and the
    // Spend Check panel — so the page cannot show two scopes at once.
    const scopedAccounts = platform
      ? accounts.filter((a) => a.provider === platform)
      : accounts

    // loadMetricsInput already tops up every ad-account currency in scope — it
    // has to, because that spend is now a cost against profit. Reusing its rate
    // table is what stops this page and the dashboard quoting different money
    // for the same spend.
    const rates = input.rates

    const spend = await accountSpendRows(scopedAccounts.map((a) => a.id), scopeIds, from, to)

    // The design's "loudly" half of the unassigned-campaign fallback: money
    // is never silently dropped (it lands on the account's default shop), but
    // that must be visible rather than silent, so the page carries a count.
    const unassignedCampaigns = await unassignedCampaignCount(scopedAccounts.map((a) => a.id))

    const engine = computeMetrics(input)
    const result = buildMarketing({
      accounts: scopedAccounts,
      spend,
      engine,
      series: dailySeries(input),
      rates,
      to,
      platform,
    })

    // accountIdsForShops filters `active: true` in both its sub-queries
    // (attribution.ts), so `accounts` above can only ever hold active ones —
    // an account switched off after spending would otherwise just vanish,
    // from the headline (by design) but also from the Spend Check panel
    // (not by design), with nothing saying money went missing. The panel —
    // and ONLY the panel — also looks at inactive accounts belonging to
    // these shops that still hold spend in the viewed range, so a human
    // sees them. `spend` and the totals above are left untouched.
    const inactiveAccounts = await db.adAccount.findMany({
      where: {
        active: false,
        shopId: { in: scopeIds },
        ...(platform ? { provider: platform } : {}),
      },
      select: {
        id: true, shopId: true, provider: true, currency: true, dailyBudget: true,
        name: true, active: true, lastSyncAt: true, lastError: true,
      },
    })
    const inactiveSpend = inactiveAccounts.length
      ? await accountSpendRows(inactiveAccounts.map((a) => a.id), scopeIds, from, to)
      : []
    // Only ones that actually have spend in range are worth surfacing — an
    // inactive account with none would just be noise nobody needs to see.
    const inactiveWithSpend = inactiveAccounts.filter((a) =>
      inactiveSpend.some((r) => r.accountId === a.id),
    )

    // "All stores" (an empty ShopFilter selection) still only ever means all
    // ACTIVE stores, so a split account with a campaign mapped to a
    // deactivated shop can be partial even when nothing was filtered — the
    // exact case the client-side caution (driven off the selection alone)
    // cannot see. Computed from the data so SpendCheck can show the caution
    // whenever it is actually true, not only when a filter is active.
    const partialAccounts = await hasPartialSplitAccounts(scopeIds)

    // Built from the SAME rows buildMarketing just consumed (plus the
    // inactive accounts above), so the panel and the headline cannot
    // describe different money.
    const now = new Date()
    const spendCheck = buildSpendCheck({
      accounts: [...scopedAccounts, ...inactiveWithSpend],
      spend: [...spend, ...inactiveSpend],
      rates,
      from,
      to,
      displayCurrency: result.displayCurrency,
      now,
    })

    return NextResponse.json(
      {
        ...result,
        spendCheck,
        connected: connectedCount > 0,
        unassignedCampaigns,
        partialAccounts,
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
