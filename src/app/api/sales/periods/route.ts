import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertOperations, AuthError } from '@/lib/auth/guard'
import { shopIdsFromQuery } from '@/lib/api/range'
import { loadMetricsInput } from '@/lib/data/load'
import { db } from '@/lib/db'
import {
  lastYearBuckets,
  mergeLastYear,
  periodBuckets,
  PERIODS,
  salesByPeriod,
  unitsByPeriod,
  type Grain,
  type ProductName,
  type UnitsRow,
} from '@/lib/metrics/periods'
import { getSetting } from '@/lib/settings'
import { todayInZone } from '@/lib/tz'
import { deltaPct } from '@/lib/metrics/trend'

const ymd = (d: Date) => d.toISOString().slice(0, 10)

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Sales by week or month, for the operations manager's Dashboard.
 *
 * Open to operations as well as the owner, which is why every field below is
 * named one by one: the engine this reads computes profit, margin and every
 * cost, and not one of them may reach his browser. Nothing is spread.
 */
export async function GET(req: Request) {
  try {
    assertOperations(await currentUser())

    const params = new URL(req.url).searchParams
    const grain: Grain = params.get('grain') === 'month' ? 'month' : 'week'
    const excludeZero = params.get('excludeZero') === '1'
    // "November 2026 vs November 2025": only when asked, because it loads a
    // second year of orders.
    const compare = params.get('compare') === '1'
    const shopIds = shopIdsFromQuery(params)

    const { timezone } = await getSetting()
    const today = todayInZone(timezone, new Date())
    const buckets = periodBuckets(grain, today, PERIODS)
    const lyBuckets = compare ? lastYearBuckets(buckets, grain) : null
    const oldest = (lyBuckets ?? buckets)[buckets.length - 1]

    // One load for the whole span; every bucket is computed from it in memory.
    const input = await loadMetricsInput({ shopIds, from: oldest.from, to: today, timezone })
    const rows = salesByPeriod(input, buckets, { excludeZero })
    const lyRows = lyBuckets ? salesByPeriod(input, lyBuckets, { excludeZero }) : null

    // The names the units table prints. The engine's loader reads no product
    // row (the Dashboard needs none), so the handful this span touched are
    // fetched here - name and SKU only, never a cost.
    const productIds = [...new Set(input.orders.flatMap((o) => o.items.map((i) => i.productId)))]
    const products = new Map<string, ProductName>(
      (
        await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, shopId: true, sku: true, externalId: true, name: true },
        })
      ).map((p) => [p.id, { productId: p.id, shopId: p.shopId, sku: p.sku, externalId: p.externalId, name: p.name }]),
    )
    const units = unitsByPeriod(input, buckets, { excludeZero, products })
    const lyUnits = lyBuckets ? unitsByPeriod(input, lyBuckets, { excludeZero, products }) : null
    const unitsRows = (now: UnitsRow[], ly: UnitsRow[] | undefined) =>
      ly
        ? mergeLastYear(now, ly).map((r) => ({ id: r.id, name: r.name, units: r.units, lastYear: r.lastYear }))
        : now.map((r) => ({ id: r.id, name: r.name, units: r.units }))

    return NextResponse.json(
      {
        grain,
        currency: input.displayCurrency,
        excludeZero,
        rows: rows.map((r, i) => ({
          from: r.from,
          to: r.to,
          soFar: r.soFar,
          orders: r.orders,
          sales: r.sales,
          avgOrder: r.avgOrder,
          units: r.units,
          vsPrevious: r.vsPrevious,
          ...(lyRows
            ? {
                lastYear: {
                  from: lyRows[i].from,
                  to: lyRows[i].to,
                  countedTo: ymd(lyBuckets![i].countedTo),
                  orders: lyRows[i].orders,
                  units: lyRows[i].units,
                  sales: lyRows[i].sales,
                },
                vsLastYear: deltaPct(r.sales, lyRows[i].sales),
              }
            : {}),
        })),
        compare,
        byShop: unitsRows(units.byShop, lyUnits?.byShop),
        byProduct: unitsRows(units.byProduct, lyUnits?.byProduct),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load sales' }, { status: 500, headers: NO_STORE })
  }
}
