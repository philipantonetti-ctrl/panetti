import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { VOIDED_STATUSES } from '@/lib/metrics/types'
import { listingsFrom, skusAcrossShops, unitsBySku } from '@/lib/inventory/skus-across-shops'

/** Admin-only catalogue detail: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * Long enough that a slow seller still registers, short enough that a product
 * discontinued last year does not read as live demand.
 */
const RECENT_DAYS = 90

/**
 * Whether one product is one SKU across the webshops.
 *
 * The Forecast tab lists what the source shops carry and pools sales by SKU.
 * Both halves rest on an assumption nobody has ever checked: that Sweden sells
 * the same SKU string Norway does. If it does not, Swedish demand never reaches
 * the Norwegian row, and the forecast is quietly ordering for one country while
 * five sell - under-ordering, which is the exact failure the forecast exists to
 * prevent, reached by another road.
 *
 * Read-only, and it answers in the live data rather than in an argument: the
 * per-shop counts say whether SKUs are shared, `sellingButNotSourced` says what
 * that is costing, and the clusters pair a stray code with the product it is
 * probably a copy of.
 *
 * Every shop, active or not. A switched-off shop is never synced again, but the
 * SKUs it once listed still carry purchasing rows, and those rows are part of
 * why the lead-times list is longer than the forecast - so they are named here
 * rather than filtered out of the explanation.
 */
export async function GET() {
  try {
    assertAdmin(await currentUser())

    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000)

    const [products, lines] = await Promise.all([
      db.product.findMany({
        select: {
          sku: true,
          // Needed to tell a real SKU from a listing that never had one: map.ts
          // stores `li.sku || String(li.product_id)`, so the two being equal is
          // what a missing SKU looks like once it reaches us.
          externalId: true,
          name: true,
          shop: { select: { name: true, stockSource: true, active: true } },
        },
      }),
      // Active shops only, matching what the forecast pools: a dead shop's old
      // orders are history, not demand anyone can still serve.
      db.orderItem.findMany({
        where: {
          order: {
            placedAt: { gte: since },
            status: { notIn: [...VOIDED_STATUSES] },
            shop: { active: true },
          },
        },
        select: { sku: true, quantity: true, order: { select: { status: true } } },
      }),
    ])

    return NextResponse.json(
      {
        recentDays: RECENT_DAYS,
        since: since.toISOString(),
        ...skusAcrossShops(listingsFrom(products), unitsBySku(lines)),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json(
      { error: 'Could not compare the shops’ SKUs' },
      { status: 500, headers: NO_STORE },
    )
  }
}
