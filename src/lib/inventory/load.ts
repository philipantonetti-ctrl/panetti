import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import { dailyBurn, hasSeasonalHistory, seasonalIndex, type Sale } from './burn'
import { forecast, type Forecast } from './forecast'
import { isUsableSku, normaliseSku } from './sku'
import { agreeStock, type AgreedStock, type ShopStock } from './stock'

export type InventoryRow = {
  sku: string
  name: string
  supplierName: string | null
  stock: AgreedStock
  burn: number
  /** False = no last year to compare against, so the rate is flat and says so. */
  seasonal: boolean
  forecast: Forecast
  byCountry: { country: string; units: number }[]
}

export type InventoryView = {
  rows: InventoryRow[]
  /** Products excluded because their SKU cannot identify a product. */
  unusable: { shopName: string; name: string; sku: string }[]
}

/** Two years, so a seasonal index has a year to compare against. */
const HISTORY_DAYS = 730

/**
 * Every purchasable product with its stock, its rate and its forecast.
 *
 * One pass over sales history rather than a query per SKU: 63 products against
 * 36,000 order lines is one round trip, not sixty-three.
 *
 * Days are UTC days, deliberately. `forecast()` normalises every date with
 * `Math.floor(t / DAY) * DAY`, which floors to UTC midnight regardless of the
 * caller's local zone — and the default `today = new Date()` here is a real
 * clock reading, not a pre-aligned constant. On a development host that runs
 * ahead of UTC, a local "today" between midnight and the UTC rollover still
 * falls on the previous UTC day, so a run-out or order-by date can appear one
 * day out from what the local wall clock suggests. This is intentional, not a
 * bug to chase: in production this runs on Vercel, whose server clock is UTC,
 * so it is exactly correct there, and a forecast measured in weeks and months
 * is not materially harmed by a one-day boundary — not worth the complexity of
 * pulling workspace-timezone handling into a purchasing forecast.
 */
export async function loadInventory(today: Date = new Date()): Promise<InventoryView> {
  const since = new Date(today.getTime() - HISTORY_DAYS * 86_400_000)

  const [items, products, lines] = await Promise.all([
    db.supplyItem.findMany({
      where: { active: true },
      select: {
        id: true, sku: true, name: true, productionDays: true, deliveryDays: true,
        moq: true, unitsPerContainer: true, coverDays: true,
        supplier: { select: { name: true } },
        purchaseOrders: {
          where: { receivedAt: null },
          select: { quantity: true, eta: true },
        },
      },
    }),
    // A deactivated shop is never synced again, so its stockQuantity reading can
    // never refresh. Without this filter an unfiltered vote lets that frozen
    // figure outvote a live shop's in agreeStock.
    db.product.findMany({
      where: { shop: { active: true } },
      select: {
        sku: true, name: true, stockQuantity: true, stockUpdatedAt: true,
        shop: { select: { name: true } },
      },
    }),
    db.orderItem.findMany({
      where: {
        order: {
          placedAt: { gte: since },
          status: { notIn: [...VOIDED_STATUSES] },
          shop: { active: true },
        },
      },
      select: {
        sku: true, quantity: true,
        order: { select: { placedAt: true, shippingCountry: true, status: true } },
      },
    }),
  ])

  // Sales, stock and countries, bucketed by SKU in one pass each.
  const sales = new Map<string, Sale[]>()
  const countries = new Map<string, Map<string, number>>()
  for (const l of lines) {
    // The SQL filter above is case-sensitive and Woo statuses are stored exactly
    // as the store sent them, custom plugin statuses included. This repeats the
    // check the way metrics/engine.ts and woo/sync.ts both do: a cancelled order
    // counted as demand would inflate every reorder quantity.
    if (VOIDED_STATUSES.includes(l.order.status.toLowerCase() as never)) continue
    if (!isUsableSku(l.sku)) continue
    const sku = normaliseSku(l.sku)
    if (!sales.has(sku)) sales.set(sku, [])
    sales.get(sku)!.push({ day: l.order.placedAt, units: l.quantity })

    const country = (l.order.shippingCountry ?? '').trim().toUpperCase() || 'Unknown'
    if (!countries.has(sku)) countries.set(sku, new Map())
    const c = countries.get(sku)!
    c.set(country, (c.get(country) ?? 0) + l.quantity)
  }

  const stocks = new Map<string, ShopStock[]>()
  const unusable: InventoryView['unusable'] = []
  for (const p of products) {
    if (!isUsableSku(p.sku)) {
      unusable.push({ shopName: p.shop.name, name: p.name, sku: p.sku })
      continue
    }
    const sku = normaliseSku(p.sku)
    if (!stocks.has(sku)) stocks.set(sku, [])
    stocks.get(sku)!.push({
      shopName: p.shop.name,
      quantity: p.stockQuantity,
      updatedAt: p.stockUpdatedAt,
    })
  }

  const rows: InventoryRow[] = items.map((item) => {
    const sku = normaliseSku(item.sku)
    const mine = sales.get(sku) ?? []
    const burn = dailyBurn(mine, today)
    const seasonal = hasSeasonalHistory(mine, today)
    const stock = agreeStock(stocks.get(sku) ?? [])

    return {
      sku,
      name: item.name,
      supplierName: item.supplier?.name ?? null,
      stock,
      burn,
      seasonal,
      forecast: forecast(
        {
          stock: stock.quantity,
          burn,
          index: (d) => seasonalIndex(mine, d, today),
          arrivals: item.purchaseOrders.map((o) => ({ eta: o.eta, quantity: o.quantity })),
          productionDays: item.productionDays,
          deliveryDays: item.deliveryDays,
          moq: item.moq,
          unitsPerContainer: item.unitsPerContainer,
          coverDays: item.coverDays,
        },
        today,
      ),
      byCountry: [...(countries.get(sku) ?? new Map())]
        .map(([country, units]) => ({ country, units }))
        .sort((a, b) => b.units - a.units),
    }
  })

  // Soonest first. A row with no run-out date has nothing to chase, so it sorts
  // after every row that does — but it is still present, because a product that
  // stopped selling or lost its stock figure is worth seeing.
  rows.sort((a, b) => {
    const at = a.forecast.runsOutOn?.getTime() ?? Infinity
    const bt = b.forecast.runsOutOn?.getTime() ?? Infinity
    return at - bt
  })

  return { rows, unusable }
}
