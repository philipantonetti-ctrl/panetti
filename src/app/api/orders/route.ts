import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'
import { getSetting } from '@/lib/settings'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'
import { utcDay } from '@/lib/dates'
import { EXCLUDED_STATUSES, VOIDED_STATUSES } from '@/lib/metrics/types'
import { costOn } from '@/lib/metrics/costs'
import { fulfillmentOn, type FulfillmentPoint } from '@/lib/metrics/engine'
import { buildRateTable, crossConvert } from '@/lib/metrics/fx'
import { loadRates } from '@/lib/fx/rates'
import { ACTIVE_GATEWAY } from '@/lib/gateways'
import { pct } from '@/lib/money'
import type { CostPoint, RateTable } from '@/lib/metrics/types'

// Voided or simply not paid yet — either way the order earns nothing (yet).
const NOT_EARNING = new Set<string>(EXCLUDED_STATUSES)

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
    // 'webshop' or 'b2b'; anything else means "both", the default.
    const source = params.get('source') ?? ''

    const activeShops = await db.shop.findMany({
      where: { active: true, ...(shopIds?.length ? { id: { in: shopIds } } : {}) },
      select: { id: true, timezone: true },
    })

    const fromDay = utcDay(from).toISOString().slice(0, 10)
    const toDay = utcDay(to).toISOString().slice(0, 10)

    /**
     * A day belongs to the shop having it.
     *
     * The metrics engine buckets each shop's orders in THAT SHOP's zone
     * (load.ts, engine.ts `inRange`), because a store keeps its own calendar.
     * This list used to bucket every order in the workspace zone instead, so a
     * store running an hour ahead put its around-midnight orders on one date
     * here and a different date on the dashboard — the same order visible on
     * one screen and missing from the other, which is exactly how it was
     * reported. One window per distinct zone, so both screens name one day.
     *
     * Grouped by zone rather than per shop: nine stores across three zones is
     * three branches, not nine. Held under AND because the free-text search
     * below owns `OR`, and two `OR` keys in one object leave only the last.
     */
    const zones = new Map<string, string[]>()
    for (const s of activeShops) {
      const zone = s.timezone ?? timezone
      zones.set(zone, [...(zones.get(zone) ?? []), s.id])
    }
    const dayWindows = {
      OR: [...zones].map(([zone, ids]) => ({
        shopId: { in: ids },
        placedAt: { gte: zoneDayStartUtc(fromDay, zone), lte: zoneDayEndUtc(toDay, zone) },
      })),
    }

    const where = {
      // Kept alongside the windows: with no shops in scope this still matches
      // nothing, without relying on how an empty `OR` is interpreted.
      shopId: { in: activeShops.map((s) => s.id) },
      AND: [dayWindows],
      // Naming a status wins outright — asking for "refunded" and getting an
      // empty list because refunds are hidden would be absurd. Otherwise the
      // default hides only VOIDED orders: a pending order is a live order and
      // belongs in the list, it just wears no figures until it is paid.
      ...(status
        ? { status }
        : includeVoided
          ? {}
          : { status: { notIn: [...VOIDED_STATUSES] } }),
      ...(source === 'b2b'
        ? { b2bCustomerId: { not: null } }
        : source === 'webshop'
          ? { b2bCustomerId: null }
          : {}),
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
          b2bCustomerId: true,
          fulfillmentCost: true,
          b2bCustomer: { select: { name: true } },
          shop: { select: { name: true, currency: true, timezone: true } },
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
    // Costs cross from the shop's currency into the order's, so a page holding
    // any order whose currency differs from its shop's needs the table. Cheap:
    // loadRates() is one indexed read and crossConvert short-circuits when the
    // two currencies match.
    const needsRates = rows.some(
      (o) => o.currency !== o.shop.currency || (!!feeRow && o.currency !== feeRow.currency),
    )
    const rates: RateTable = needsRates ? buildRateTable(await loadRates()) : new Map()

    const orders = rows.map((o) => {
      const earnsNothing = NOT_EARNING.has(o.status.toLowerCase())

      let figures = null
      if (!earnsNothing) {
        // Costs are held in the SHOP's currency, which a B2B order invoiced in
        // another currency does not share. Same correction as engine.ts.
        const costCurrency = o.shop.currency
        const toOrder = (amount: number) =>
          crossConvert(amount, costCurrency, o.currency, o.placedAt, rates)

        const cogs = toOrder(
          o.items.reduce((sum, i) => {
            const cost = costOn(costs.get(i.productId) ?? [], o.placedAt)
            return sum + i.quantity * (cost.costPerItem + cost.handlingCost)
          }, 0),
        )
        // A hand-entered order carries what shipping actually cost; a webshop
        // order is charged the shop's rate on its day.
        const fulfillment = toOrder(
          o.fulfillmentCost ?? fulfillmentOn(fulfillmentRates.get(o.shopId) ?? [], o.placedAt),
        )
        // An invoiced order never went through the gateway.
        const fee =
          feeRow && o.b2bCustomerId === null
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
        /**
         * The clock this order was placed on. Sent because the browser must not
         * be the one to decide: a plain Intl format with no timeZone renders in
         * whatever zone the VIEWER's computer is in, so the same sale read as
         * 15:40 in Stockholm and 21:40 from Manila — and an evening order read
         * as the next day. The list is already filtered by this same zone, so
         * showing any other one would contradict the rows it just chose.
         */
        timezone: o.shop.timezone ?? timezone,
        currency: o.currency,
        netSales: o.netSales,
        discountTotal: o.discountTotal,
        taxTotal: o.taxTotal,
        shippingCharged: o.shippingCharged,
        total: o.total,
        couponCode: o.couponCode,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        source: o.b2bCustomerId === null ? ('webshop' as const) : ('b2b' as const),
        customer: o.b2bCustomer?.name ?? null,
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
    console.error(e)
    return NextResponse.json({ error: 'Could not load orders' }, { status: 500, headers: NO_STORE })
  }
}
