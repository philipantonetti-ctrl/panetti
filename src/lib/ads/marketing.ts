import { crossConvert } from '../metrics/fx'
import type { EngineResult, RateTable } from '../metrics/types'
import type { SeriesPoint } from '../metrics/trend'

/**
 * Ad performance per shop: converted spend laid over the SAME order figures the
 * dashboard shows, so "orders" and "gross revenue" here can never disagree with
 * the numbers one tab over.
 */

export type MarketingAccount = { id: string; shopId: string; provider: string; currency: string }

export type SpendRow = {
  accountId: string
  date: Date
  spend: number
  impressions: number
  clicks: number
}

export type MarketingShopRow = {
  shopId: string
  shopName: string
  spend: number // display currency minor units
  metaSpend: number
  googleSpend: number
  impressions: number
  clicks: number
  orders: number
  grossRevenue: number
  roas: number | null // gross revenue per unit of spend, e.g. 4.2
  cpa: number | null // spend per paid order, minor units
  cpc: number | null // spend per click, minor units
  ctr: number | null // clicks / impressions, e.g. 0.019
}

export type MarketingSeriesPoint = { date: string; spend: number; grossRevenue: number }

export type MarketingResult = {
  displayCurrency: string
  byShop: MarketingShopRow[]
  total: MarketingShopRow
  series: MarketingSeriesPoint[]
}

/** A ratio with a zero denominator is not a number, and printing one would lie. */
const ratios = (row: Omit<MarketingShopRow, 'roas' | 'cpa' | 'cpc' | 'ctr'>): MarketingShopRow => ({
  ...row,
  roas: row.spend > 0 ? row.grossRevenue / row.spend : null,
  cpa: row.spend > 0 && row.orders > 0 ? Math.round(row.spend / row.orders) : null,
  cpc: row.spend > 0 && row.clicks > 0 ? Math.round(row.spend / row.clicks) : null,
  ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
})

export function buildMarketing(args: {
  accounts: MarketingAccount[]
  spend: SpendRow[]
  engine: EngineResult
  series: SeriesPoint[]
  rates: RateTable
}): MarketingResult {
  const display = args.engine.displayCurrency
  const accountById = new Map(args.accounts.map((a) => [a.id, a]))

  type Acc = { spend: number; metaSpend: number; googleSpend: number; impressions: number; clicks: number }
  const zero = (): Acc => ({ spend: 0, metaSpend: 0, googleSpend: 0, impressions: 0, clicks: 0 })
  const byShop = new Map<string, Acc>()
  const byDay = new Map<string, number>()

  for (const row of args.spend) {
    const account = accountById.get(row.accountId)
    if (!account) continue // an account outside the current shop scope

    // Each day's spend converts at that day's rate. Cross-convert, because an
    // account can bill in a currency that is neither the shop's nor USD.
    const minor = crossConvert(row.spend, account.currency, display, row.date, args.rates)
    const acc = byShop.get(account.shopId) ?? zero()
    acc.spend += minor
    if (account.provider === 'meta') acc.metaSpend += minor
    else acc.googleSpend += minor
    acc.impressions += row.impressions
    acc.clicks += row.clicks
    byShop.set(account.shopId, acc)

    const day = row.date.toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + minor)
  }

  // Every shop in scope gets a row — a shop without ad accounts shows zero
  // spend and dashes, not absence.
  const rows = args.engine.byShop.map((shop) => {
    const acc = byShop.get(shop.shopId) ?? zero()
    return ratios({
      shopId: shop.shopId,
      shopName: shop.shopName,
      ...acc,
      orders: shop.orders,
      grossRevenue: shop.grossRevenue,
    })
  })

  const total = ratios({
    shopId: '',
    shopName: 'Total',
    spend: rows.reduce((n, r) => n + r.spend, 0),
    metaSpend: rows.reduce((n, r) => n + r.metaSpend, 0),
    googleSpend: rows.reduce((n, r) => n + r.googleSpend, 0),
    impressions: rows.reduce((n, r) => n + r.impressions, 0),
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    orders: args.engine.total.orders,
    grossRevenue: args.engine.total.grossRevenue,
  })

  const series = args.series.map((p) => ({
    date: p.date,
    spend: byDay.get(p.date) ?? 0,
    grossRevenue: p.grossRevenue,
  }))

  return { displayCurrency: display, byShop: rows, total, series }
}
