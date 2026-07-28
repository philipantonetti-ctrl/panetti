import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'
import { costOn } from '@/lib/metrics/costs'
import { fulfillmentOn, type FulfillmentPoint } from '@/lib/metrics/engine'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { loadRates } from '@/lib/fx/rates'
import { ACTIVE_GATEWAY } from '@/lib/gateways'
import { pct } from '@/lib/money'
import type { CostPoint, RateTable } from '@/lib/metrics/types'

const VOIDED = new Set<string>(EXCLUDED_STATUSES)

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * The order list for admins: every order in a date range, newest first, with
 * what was bought inside each one and what it truly earned. Paged, because a
 * busy store has tens of thousands. Each order is shown in ITS OWN currency —
 * an order only ever has one — so nothing here needs a display conversion.
 *
 * Unlike the metric screens this list can show refunded and cancelled orders
 * (`includeVoided`, or naming a `status` outright): seeing that an order WAS
 * refunded is the point of an order browser. Their money figures come back
 * null — a voided order earns nothing, and pretending otherwise would lie.
 *
 * Per-order figures mirror the engine exactly, at the rates in force on the
 * order's own date: cogs, fulfillment, gateway fee, commission, and
 * contribution profit = net sales + shipping − all of those.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const params = new URL(req.url).searchParams
    const { timezone } = await getSetting()
    const { from, to } = rangeFromQuery(params, new Date(), timezone)
    const shopIds = shopIdsFromQuery(params)

    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200)
    const offset = Math.max(Number(params.get('offset')) || 0, 0)
    const includeVoided = params.get('includeVoided') === 'true'
    const status = params.get('status')?.toLowerCase() ?? ''
    const q = params.get('q')?.trim() ?? ''

    const activeShops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true },
    })

    const where = {
      shopId: { in: activeShops.map((s) => s.id) },
      placedAt: {
        gte: zoneDayStartUtc(utcDay(from).toISOString().slice(0, 10), timezone),
        lte: zoneDayEndUtc(utcDay(to).toISOString().slice(0, 10), timezone),
      },
      // Naming a status wins outright — asking for "refunded" and getting an
      // empty list because refunds are hidden would be absurd. Otherwise the
      // default hides voided orders, like every other figure, unless the list
      // opts back in to see the whole picture.
      ...(status
        ? { status }
        : includeVoided
          ? {}
          : { status: { notIn: [...EXCLUDED_STATUSES] } }),
      ...(q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' as const } },
              { customerName: { contains: q, mode: 'insensitive' as const } },
              { customerEmail: { contains: q, mode: 'insensitive' as const } },
              { couponCode: { contains: q, mode: 'insensitive' as const } },
              { items: { some: { name: { contains: q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    }

    const [total, rows] = await Promise.all([
      db.order.count({ where }),
      db.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          shopId: true,
          number: true,
          placedAt: true,
          status: true,
          currency: true,
          netSales: true,
          discountTotal: true,
          taxTotal: true,
          shippingCharged: true,
          total: true,
          couponCode: true,
          customerName: true,
          customerEmail: true,
          ambassadorId: true,
          shop: { select: { name: true } },
          items: {
            select: {
              productId: true,
              name: true,
              sku: true,
              quantity: true,
              unitPrice: true,
              lineNetTotal: true,
              product: { select: { imageUrl: true } },
            },
          },
        },
      }),
    ])

    // Everything the figures need, fetched once for the page, never per row.
    const productIds = [...new Set(rows.flatMap((o) => o.items.map((i) => i.productId)))]
    const costRows = productIds.length
      ? await db.productCost.findMany({ where: { productId: { in: productIds } } })
      : []
    const costs = new Map<string, CostPoint[]>()
    for (const c of costRows) {
      const list = costs.get(c.productId) ?? []
      list.push({ costPerItem: c.costPerItem, handlingCost: c.handlingCost, effectiveFrom: c.effectiveFrom })
      costs.set(c.productId, list)
    }

    const pageShopIds = [...new Set(rows.map((o) => o.shopId))]
    const rateRows = pageShopIds.length
      ? await db.fulfillmentRate.findMany({ where: { shopId: { in: pageShopIds } } })
      : []
    const fulfillmentRates = new Map<string, FulfillmentPoint[]>()
    for (const r of rateRows) {
      const list = fulfillmentRates.get(r.shopId) ?? []
      list.push({ perOrder: r.perOrder, effectiveFrom: r.effectiveFrom })
      fulfillmentRates.set(r.shopId, list)
    }

    const ambassadorIds = [...new Set(rows.map((o) => o.ambassadorId).filter((x): x is string => !!x))]
    const rateByAmbassador = new Map(
      ambassadorIds.length
        ? (
            await db.ambassador.findMany({
              where: { id: { in: ambassadorIds } },
              select: { id: true, commissionRate: true },
            })
          ).map((a) => [a.id, a.commissionRate])
        : [],
    )

    const feeRow = await db.processingFee.findFirst({
      where: { gateway: ACTIVE_GATEWAY, active: true, noFeesApply: false },
    })
    // FX only matters for the fee's fixed part crossing into another currency.
    // No provider call here — the scheduled sync keeps rates topped up, and
    // crossConvert falls back to the nearest earlier rate it holds.
    const needsRates =
      !!feeRow && feeRow.fixedMinor !== 0 && rows.some((o) => o.currency !== feeRow.currency)
    const rates: RateTable = needsRates ? buildRateTable(await loadRates()) : new Map()

    const orders = rows.map((o) => {
      const isVoided = VOIDED.has(o.status.toLowerCase())

      let figures = null
      if (!isVoided) {
        const cogs = o.items.reduce((sum, i) => {
          const cost = costOn(costs.get(i.productId) ?? [], o.placedAt)
          return sum + i.quantity * (cost.costPerItem + cost.handlingCost)
        }, 0)
        const fulfillment = fulfillmentOn(fulfillmentRates.get(o.shopId) ?? [], o.placedAt)
        const fee = feeRow
          ? Math.round((o.total * feeRow.percent) / 100) +
            crossConvert(feeRow.fixedMinor, feeRow.currency, o.currency, o.placedAt, rates)
          : 0
        const commission = o.ambassadorId
          ? pct(o.netSales, rateByAmbassador.get(o.ambassadorId) ?? 0)
          : 0
        const netRevenue = o.netSales + o.shippingCharged
        const profit = netRevenue - cogs - fulfillment - fee - commission
        figures = {
          cogs,
          fulfillment,
          fee,
          commission,
          profit,
          margin: netRevenue === 0 ? 0 : profit / netRevenue,
        }
      }

      return {
        id: o.id,
        number: o.number,
        placedAt: o.placedAt.toISOString(),
        status: o.status,
        shop: o.shop.name,
        currency: o.currency,
        netSales: o.netSales,
        discountTotal: o.discountTotal,
        taxTotal: o.taxTotal,
        shippingCharged: o.shippingCharged,
        total: o.total,
        couponCode: o.couponCode,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
        products: o.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          lineNetTotal: i.lineNetTotal,
          imageUrl: i.product.imageUrl,
        })),
        figures,
      }
    })

    return NextResponse.json({ orders, total }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load orders' }, { status: 500, headers: NO_STORE })
  }
}
