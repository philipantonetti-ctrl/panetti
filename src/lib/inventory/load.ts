import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import {
  dailyBurn,
  hasSeasonalHistory,
  seasonalIndex,
  seasonalLevel,
  yearOverYear,
  type Sale,
} from './burn'
import { forecast, type Forecast } from './forecast'
import { isUsableSku, normaliseSku } from './sku'
import { catalogueOf } from './sources'
import { agreeStock, type AgreedStock, type ShopStock } from './stock'

export type InventoryRow = {
  sku: string
  name: string
  /** Product photo, from the shops that report stock. Null when none carries one. */
  imageUrl: string | null
  supplierName: string | null
  stock: AgreedStock
  burn: number
  /**
   * This period against the same period last year, as a fraction. Null when
   * there is no matching period to compare against.
   *
   * Shown rather than kept internal because it IS the growth the forecast
   * applies: `seasonalLevel` reads the current rate with the season taken out,
   * so every future day comes out at last year's sales on that date times
   * exactly this. The client asked whether the system can see the business
   * growing; this is the page answering in a number.
   */
  trend: number | null
  /** False = no last year to compare against, so the rate is flat and says so. */
  seasonal: boolean
  forecast: Forecast
  byCountry: { country: string; units: number }[]
}

export type InventoryView = {
  rows: InventoryRow[]
  /** Products excluded because their SKU cannot identify a product. */
  unusable: { shopName: string; name: string; sku: string }[]
  /**
   * Which shops the stock figures and product names came from. Empty = nobody
   * has chosen, so every active shop counted.
   *
   * Returned rather than left to the page to work out, because the page would
   * have to repeat this query to learn it, and the two could then disagree
   * about what the rows on screen are actually made of.
   */
  stockFrom: string[]
  /** How many active shops fed the SALES side, which is never scoped. */
  shopCount: number
}

/** Two years, so a seasonal index has a year to compare against. */
const HISTORY_DAYS = 730

/**
 * Units of a purchase order that are still on the water.
 *
 * Whatever has already been received is already in the stock figure, so counting
 * the whole order as incoming would count those units twice — and the forecast
 * would then advise ordering too little, which is the exact failure this feature
 * exists to prevent, reached by another road.
 *
 * A hand-entered row has no `receivedQuantity` and so contributes its whole
 * quantity, exactly as it did before the column existed.
 *
 * Never negative: Visma can record more delivered than ordered, and an
 * over-receipt on one order must not cancel out another order's incoming stock.
 */
export function outstanding(order: {
  quantity: number
  receivedQuantity: number | null
}): number {
  return Math.max(0, order.quantity - (order.receivedQuantity ?? 0))
}

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

  // Which shops' catalogues decide what is listed and what "in stock" means.
  // Empty = nobody has chosen, so every active shop counts and this behaves
  // exactly as it did before the setting existed. Deliberately its own query
  // and awaited first: it decides the shape of the product query below, and
  // guessing wrong would mean fetching every shop's catalogue to throw most of
  // it away.
  const [sources, shopCount] = await Promise.all([
    db.shop.findMany({
      where: { active: true, stockSource: true },
      // Alphabetical, so the sentence the page builds from these does not
      // reshuffle its shop names between two loads of the same data.
      orderBy: { name: 'asc' },
      select: { name: true },
    }),
    db.shop.count({ where: { active: true } }),
  ])
  const scoped = sources.length > 0

  const [items, products, lines] = await Promise.all([
    db.supplyItem.findMany({
      where: { active: true },
      select: {
        id: true, sku: true, name: true, productionDays: true, deliveryDays: true,
        moq: true, unitsPerContainer: true, coverDays: true,
        supplier: { select: { name: true } },
        purchaseOrders: {
          where: { receivedAt: null },
          select: { quantity: true, receivedQuantity: true, eta: true },
        },
      },
    }),
    // A deactivated shop is never synced again, so its stockQuantity reading can
    // never refresh. Without this filter an unfiltered vote lets that frozen
    // figure outvote a live shop's in agreeStock. `stockSource` narrows it
    // further when shops have been named — a drifted mirror should not get a
    // vote at all, rather than be outvoted.
    db.product.findMany({
      where: { shop: { active: true, ...(scoped ? { stockSource: true } : {}) } },
      select: {
        sku: true, name: true, imageUrl: true, stockQuantity: true, stockUpdatedAt: true,
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
  // What each product is CALLED, according to the shops that count. SupplyItem
  // snapshots its name once, from whichever shop the database returned first
  // and never updates it, which is why Norwegian products were listed under
  // their Finnish and Swedish names. Reading the name here instead fixes every
  // existing row without a migration, and keeps following the source shop if
  // the listing is renamed.
  //
  // Shared with the Suppliers & lead times page rather than repeated, so the
  // two tabs cannot end up calling the same product different things — which is
  // the whole bug, one page further along.
  const names = catalogueOf(products)
  // And what it LOOKS like, from the same shops and for the same reason. A
  // photo is how someone recognises "Rei'itetty Pizzalapio" without translating
  // it first. First one wins, so a shop that carries no image cannot blank out
  // a picture another shop does have.
  const images = new Map<string, string>()
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
    if (!images.has(sku) && p.imageUrl) images.set(sku, p.imageUrl)
  }

  // Scoped, the source shops' catalogue IS the product list: an item they do
  // not carry is not a thing to forecast here. Unscoped, every SupplyItem is
  // kept exactly as before — a product whose shops stopped listing it keeps its
  // lead times and its open orders, which is the promise ensureSupplyItems makes.
  const listed = scoped ? items.filter((i) => stocks.has(normaliseSku(i.sku))) : items

  const rows: InventoryRow[] = listed.map((item) => {
    const sku = normaliseSku(item.sku)
    const mine = sales.get(sku) ?? []
    const burn = dailyBurn(mine, today)
    const seasonal = hasSeasonalHistory(mine, today)
    const stock = agreeStock(stocks.get(sku) ?? [])

    // One season, read once, used twice — first to take the season OUT of the
    // rate we can see, then to put the right season back on each future day.
    // Those two have to be the same function or the two halves disagree.
    const index = (d: Date) => seasonalIndex(mine, d, today)

    return {
      sku,
      name: names.get(sku) ?? item.name,
      imageUrl: images.get(sku) ?? null,
      supplierName: item.supplier?.name ?? null,
      stock,
      burn,
      trend: yearOverYear(mine, today),
      seasonal,
      forecast: forecast(
        {
          stock: stock.quantity,
          // NOT `burn`. That is what is selling in whatever season we are
          // standing in; multiplying it by the next season's index would count
          // the season twice and order for two Christmases.
          level: seasonalLevel(mine, today, index),
          index,
          arrivals: item.purchaseOrders.map((o) => ({ eta: o.eta, quantity: outstanding(o) })),
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

  return { rows, unusable, stockFrom: sources.map((s) => s.name), shopCount }
}
