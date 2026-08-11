import { db } from '../db'
import { getSetting } from '../settings'
import { todayInZone } from '../tz'
import { groupByCurrency } from '../currency-groups'
import { loadMetricsInput } from '../data/load'
import { loadProductsInput } from '../data/load-products'
import { loadDelivery } from '../delivery/load'
import { computeMetrics } from '../metrics'
import { previousRange } from '../metrics/trend'
import { productFigures } from '../metrics/products'
import { leaderboard } from '../metrics/ambassadors'
import { deliveryStats } from '../delivery/stats'
import { buildMarketing } from '../ads/marketing'
import { accountIdsForShops, accountSpendRows } from '../ads/attribution'
import { moneyFacts } from './facts/money'
import { deliveryFacts } from './facts/delivery'
import { productFacts } from './facts/products'
import { ambassadorFacts, b2bQuietFacts, type B2bHistory } from './facts/customers'
import { qualityFacts } from './facts/quality'
import { isQuality, type Fact } from './types'

/**
 * Everything the advisor knows about this morning.
 *
 * Every figure here comes back out of the same loaders and the same engine the
 * pages use, run over two windows. Nothing in this file adds, divides or
 * converts money — it gathers, compares through the fact builders, and ranks.
 */

/** The window the briefing describes. A week reads through weekday effects. */
export const WINDOW_DAYS = 7

/**
 * How many ranked facts the model is shown. Enough to see the shape of the
 * week; few enough that the prompt stays small and the ranking stays a
 * decision rather than a dump. Quality facts are sent on top of this.
 */
export const MAX_FACTS = 40

const DAY_MS = 24 * 60 * 60 * 1000

export type CollectedFacts = { from: Date; to: Date; facts: Fact[] }

export async function collectFacts(now: Date = new Date()): Promise<CollectedFacts> {
  const { timezone } = await getSetting()

  // Through YESTERDAY, not today: a briefing read at 07:00 that includes three
  // hours of today would compare a part-day against seven whole ones. "Today"
  // is HIS calendar day, the same todayInZone write.ts upserts against —
  // using UTC's day here instead let Refresh, pressed late evening UTC,
  // silently replace the morning's briefing with a window computed for the
  // wrong day.
  const to = new Date(todayInZone(timezone, now).getTime() - DAY_MS)
  const from = new Date(to.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  const before = previousRange(from, to)

  const [input, priorInput] = await Promise.all([
    loadMetricsInput({ from, to, timezone }),
    loadMetricsInput({ from: before.from, to: before.to, timezone }),
  ])

  const engine = computeMetrics(input)
  const priorEngine = computeMetrics(priorInput)
  const baseline = priorEngine.total.netRevenue

  const shops = await db.shop.findMany({
    where: { active: true },
    select: { id: true, name: true, currency: true, lastError: true },
    orderBy: { name: 'asc' },
  })
  const shopIds = shops.map((s) => s.id)

  const facts: Fact[] = []

  // --- money and marketing -------------------------------------------------
  //
  // Accounts are resolved through accountIdsForShops, NOT by filtering adAccount
  // on shopId. A split account can run campaigns for a shop while its own
  // default shop is out of scope; filtering on shopId alone silently drops
  // those campaigns' spend. This is the pattern /api/marketing already uses.
  const accountIds = await accountIdsForShops(shopIds)
  const accounts = await db.adAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, shopId: true, provider: true, currency: true, dailyBudget: true },
  })

  const marketingFor = async (start: Date, end: Date, engineResult = engine, rates = input.rates) => {
    const spend = await accountSpendRows(
      accounts.map((a) => a.id),
      shopIds,
      start,
      end,
    )
    return buildMarketing({
      accounts,
      spend,
      engine: engineResult,
      series: [],
      rates,
      to: end,
    })
  }

  const [nowMarketing, beforeMarketing] = await Promise.all([
    marketingFor(from, to, engine),
    marketingFor(before.from, before.to, priorEngine, priorInput.rates),
  ])

  facts.push(
    ...moneyFacts({
      now: engine,
      before: priorEngine,
      nowMarketing,
      beforeMarketing,
      days: WINDOW_DAYS,
    }),
  )

  // --- delivery ------------------------------------------------------------
  for (const shop of shops) {
    const [current, prior] = await Promise.all([
      loadDelivery([shop.id], from, to, now),
      loadDelivery([shop.id], before.from, before.to, now),
    ])
    facts.push(
      ...deliveryFacts({
        shopId: shop.id,
        shopName: shop.name,
        now: deliveryStats(
          current.rows.map((r) => r.view),
          current.rows.map((r) => r.order.shippingCountry),
        ),
        before: deliveryStats(
          prior.rows.map((r) => r.view),
          prior.rows.map((r) => r.order.shippingCountry),
        ),
      }),
    )
  }

  // --- products, one currency group at a time ------------------------------
  //
  // loadProductsInput THROWS MixedCurrencyError rather than adding NOK to EUR,
  // which is correct and is why this loop exists. Each group is loaded in its
  // own currency and compared in it.
  const shopShares = new Map(
    priorEngine.byShop.map((s) => [s.shopId, baseline > 0 ? s.netRevenue / baseline : 0]),
  )
  const uncostedByShop: { shopId: string; shopName: string; count: number }[] = []

  for (const group of groupByCurrency(shops)) {
    const groupIds = group.shops.map((s) => s.id)
    const [nowProducts, beforeProducts] = await Promise.all([
      loadProductsInput({ shopIds: groupIds, from, to, timezone }),
      loadProductsInput({ shopIds: groupIds, from: before.from, to: before.to, timezone }),
    ])

    const nowFigures = productFigures(nowProducts)
    const beforeFigures = productFigures(beforeProducts)

    // The shop's own prior revenue must be in THIS group's currency, and
    // priorEngine reports it in USD whenever more than one shop is loaded. A
    // single-shop load returns that shop's own currency, which is what the
    // per-shop product figures are in.
    const groupBaselines = new Map<string, number>()
    await Promise.all(
      groupIds.map(async (id) => {
        const own = computeMetrics(await loadMetricsInput({ shopIds: [id], from: before.from, to: before.to, timezone }))
        groupBaselines.set(id, own.total.netRevenue)
      }),
    )

    facts.push(
      ...productFacts({
        now: nowFigures,
        before: beforeFigures,
        shopNames: new Map(group.shops.map((s) => [s.id, s.name])),
        shopBaselines: groupBaselines,
        shopShares,
      }),
    )

    // Which shops have products with no cost. productFigures reports the count
    // across the whole result, so it is recounted per shop from the rows.
    for (const shop of group.shops) {
      const count = nowFigures.rows.filter((row) =>
        row.stores.some((s) => s.shopId === shop.id && !s.hasCost),
      ).length
      uncostedByShop.push({ shopId: shop.id, shopName: shop.name, count })
    }
  }

  // --- customers and ambassadors -------------------------------------------
  const roster = await db.ambassador.findMany({
    where: { active: true },
    select: { id: true, name: true, codes: { select: { shop: { select: { name: true } } } } },
  })
  const people = roster.map((a) => ({
    id: a.id,
    name: a.name,
    shops: [...new Set(a.codes.map((c) => c.shop.name))],
  }))

  facts.push(
    ...ambassadorFacts({
      now: leaderboard({
        ambassadors: people,
        orders: input.orders,
        rates: input.rates,
        displayCurrency: input.displayCurrency,
        from,
        to,
        timezone,
      }),
      before: leaderboard({
        ambassadors: people,
        orders: priorInput.orders,
        rates: priorInput.rates,
        displayCurrency: priorInput.displayCurrency,
        from: before.from,
        to: before.to,
        timezone,
      }),
      baseline,
      // Sales in both leaderboards are already converted to this — the same
      // value money.ts uses for every other money fact this file produces.
      currency: engine.displayCurrency,
    }),
  )

  const customerRows = await db.b2bCustomer.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      shopId: true,
      shop: { select: { name: true } },
      orders: { select: { placedAt: true }, orderBy: { placedAt: 'asc' } },
    },
  })
  const customers: B2bHistory[] = customerRows.map((c) => ({
    customerId: c.id,
    name: c.name,
    shopId: c.shopId,
    shopName: c.shop.name,
    orderDates: c.orders.map((o) => o.placedAt),
  }))
  facts.push(...b2bQuietFacts({ customers, now }))

  // --- data quality --------------------------------------------------------
  const currencies = [...new Set(shops.map((s) => s.currency))]
  const haveRates = new Set(
    (
      await db.fxRate.findMany({
        where: { date: { gte: from, lte: to }, quote: 'USD' },
        select: { base: true },
      })
    ).map((r) => r.base),
  )
  const missingRates =
    engine.displayCurrency === 'USD'
      ? currencies.filter((c) => c !== 'USD' && !haveRates.has(c))
      : []

  facts.push(
    ...qualityFacts({
      uncostedByShop,
      failingShops: shops
        .filter((s) => s.lastError)
        .map((s) => ({ shopId: s.id, shopName: s.name, error: s.lastError! })),
      missingRates,
    }),
  )

  // Rank, then cap — but never cap away a trust warning. A briefing that
  // silently drops "this shop's sync is broken" because forty things moved is
  // the exact failure this whole feature exists to avoid.
  const quality = facts.filter(isQuality)
  const ranked = facts
    .filter((f) => !isQuality(f))
    .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))
    .slice(0, MAX_FACTS)

  return { from, to, facts: [...quality, ...ranked] }
}
