import { crossConvert } from '../metrics/fx'
import type { EngineResult, RateTable } from '../metrics/types'
import type { SeriesPoint } from '../metrics/trend'

/**
 * Ad performance per shop: converted spend laid over the SAME order figures the
 * dashboard shows, so "orders" and "gross revenue" here can never disagree with
 * the numbers one tab over.
 */

export type MarketingAccount = {
  id: string
  shopId: string
  provider: string
  currency: string
  /** Current daily budget across active campaigns, minor units, account currency. */
  dailyBudget: number | null
}

export type SpendRow = {
  accountId: string
  /** Set only by a split account: the shop this slice of the account's spend
   *  belongs to, overriding the account's own. Absent means "use the account's". */
  shopId?: string
  date: Date
  spend: number
  impressions: number
  clicks: number
  linkClicks: number
  conversions: number
  conversionValue: number
  videoViews3s: number
  thruplays: number
}

export type MarketingShopRow = {
  shopId: string
  shopName: string
  spend: number // display currency minor units
  dailyBudget: number | null // current daily budgets, null when no account reports one
  metaSpend: number
  googleSpend: number
  impressions: number
  clicks: number
  linkClicks: number
  conversions: number // platform-attributed purchases
  conversionValue: number // display currency minor units
  videoViews3s: number
  thruplays: number
  orders: number
  grossRevenue: number
  roas: number | null // store ROAS: whole-store gross revenue per unit of spend
  platformRoas: number | null // what the platform attributes: conversion value / spend
  cpa: number | null // spend per paid order, minor units
  costPerPurchase: number | null // spend per platform purchase, minor units
  avgPurchaseValue: number | null // conversion value per purchase, minor units
  cpm: number | null // spend per thousand impressions, minor units
  cpc: number | null // spend per click, minor units
  costPerLinkClick: number | null // spend per link click, minor units
  ctr: number | null // clicks / impressions, e.g. 0.019
  linkCtr: number | null // link clicks / impressions
  holdRate: number | null // thruplays / 3-second plays
}

export type MarketingSeriesPoint = { date: string; spend: number; grossRevenue: number }

export type MarketingResult = {
  displayCurrency: string
  byShop: MarketingShopRow[]
  total: MarketingShopRow
  series: MarketingSeriesPoint[]
}

type Ratioless = Omit<
  MarketingShopRow,
  | 'roas'
  | 'platformRoas'
  | 'cpa'
  | 'costPerPurchase'
  | 'avgPurchaseValue'
  | 'cpm'
  | 'cpc'
  | 'costPerLinkClick'
  | 'ctr'
  | 'linkCtr'
  | 'holdRate'
>

/** A ratio with a zero denominator is not a number, and printing one would lie. */
const ratios = (row: Ratioless): MarketingShopRow => ({
  ...row,
  roas: row.spend > 0 ? row.grossRevenue / row.spend : null,
  platformRoas: row.spend > 0 ? row.conversionValue / row.spend : null,
  cpa: row.spend > 0 && row.orders > 0 ? Math.round(row.spend / row.orders) : null,
  costPerPurchase:
    row.spend > 0 && row.conversions > 0 ? Math.round(row.spend / row.conversions) : null,
  avgPurchaseValue: row.conversions > 0 ? Math.round(row.conversionValue / row.conversions) : null,
  cpm: row.impressions > 0 ? Math.round((row.spend / row.impressions) * 1000) : null,
  cpc: row.spend > 0 && row.clicks > 0 ? Math.round(row.spend / row.clicks) : null,
  costPerLinkClick:
    row.spend > 0 && row.linkClicks > 0 ? Math.round(row.spend / row.linkClicks) : null,
  ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
  linkCtr: row.impressions > 0 ? row.linkClicks / row.impressions : null,
  holdRate: row.videoViews3s > 0 ? row.thruplays / row.videoViews3s : null,
})

export function buildMarketing(args: {
  accounts: MarketingAccount[]
  spend: SpendRow[]
  engine: EngineResult
  series: SeriesPoint[]
  rates: RateTable
  /** Range end: a current setting like the budget converts at the current rate. */
  to: Date
}): MarketingResult {
  const display = args.engine.displayCurrency
  const accountById = new Map(args.accounts.map((a) => [a.id, a]))

  // Budgets come from the accounts themselves, not the spend rows — an account
  // that spent nothing this period still has its budget set.
  const budgetByShop = new Map<string, number>()
  for (const account of args.accounts) {
    if (account.dailyBudget === null) continue
    const minor = crossConvert(account.dailyBudget, account.currency, display, args.to, args.rates)
    budgetByShop.set(account.shopId, (budgetByShop.get(account.shopId) ?? 0) + minor)
  }

  type Acc = {
    spend: number
    metaSpend: number
    googleSpend: number
    impressions: number
    clicks: number
    linkClicks: number
    conversions: number
    conversionValue: number
    videoViews3s: number
    thruplays: number
  }
  const zero = (): Acc => ({
    spend: 0,
    metaSpend: 0,
    googleSpend: 0,
    impressions: 0,
    clicks: 0,
    linkClicks: 0,
    conversions: 0,
    conversionValue: 0,
    videoViews3s: 0,
    thruplays: 0,
  })
  const byShop = new Map<string, Acc>()
  const byDay = new Map<string, number>()

  for (const row of args.spend) {
    const account = accountById.get(row.accountId)
    if (!account) continue // an account outside the current shop scope

    // Money converts at that day's rate. Cross-convert, because an account can
    // bill in a currency that is neither the shop's nor USD.
    const minor = crossConvert(row.spend, account.currency, display, row.date, args.rates)
    const valueMinor = crossConvert(row.conversionValue, account.currency, display, row.date, args.rates)
    // A split account's row carries its own shopId, overriding the account's —
    // a whole account's row has none, so it falls back to the account's own.
    const shopId = row.shopId ?? account.shopId
    const acc = byShop.get(shopId) ?? zero()
    acc.spend += minor
    if (account.provider === 'meta') acc.metaSpend += minor
    else acc.googleSpend += minor
    acc.impressions += row.impressions
    acc.clicks += row.clicks
    acc.linkClicks += row.linkClicks
    acc.conversions += row.conversions
    acc.conversionValue += valueMinor
    acc.videoViews3s += row.videoViews3s
    acc.thruplays += row.thruplays
    byShop.set(shopId, acc)

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
      dailyBudget: budgetByShop.get(shop.shopId) ?? null,
      ...acc,
      orders: shop.orders,
      grossRevenue: shop.grossRevenue,
    })
  })

  const budgets = rows.filter((r) => r.dailyBudget !== null)
  const total = ratios({
    shopId: '',
    shopName: 'Total',
    dailyBudget: budgets.length ? budgets.reduce((n, r) => n + (r.dailyBudget ?? 0), 0) : null,
    spend: rows.reduce((n, r) => n + r.spend, 0),
    metaSpend: rows.reduce((n, r) => n + r.metaSpend, 0),
    googleSpend: rows.reduce((n, r) => n + r.googleSpend, 0),
    impressions: rows.reduce((n, r) => n + r.impressions, 0),
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    linkClicks: rows.reduce((n, r) => n + r.linkClicks, 0),
    conversions: rows.reduce((n, r) => n + r.conversions, 0),
    conversionValue: rows.reduce((n, r) => n + r.conversionValue, 0),
    videoViews3s: rows.reduce((n, r) => n + r.videoViews3s, 0),
    thruplays: rows.reduce((n, r) => n + r.thruplays, 0),
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
