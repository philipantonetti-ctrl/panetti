import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'
import { lineTotals, orderTotals, type B2bLine } from '@/lib/b2b/pricing'
import { b2bExternalId, nextB2bNumber } from '@/lib/b2b/numbering'
import { assertProductsBelongToShop } from '../customers/route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const Line = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1),
  /** MAJOR units, customer currency, ex VAT, before discount. */
  unitPrice: z.number().min(0),
  /** 10 for "10%", or 20 for "20.00 off each one". */
  discountValue: z.number().min(0).default(0),
  discountKind: z.enum(['PERCENT', 'AMOUNT']).default('PERCENT'),
  /** Tick to make this the customer's standing price from now on. */
  savePrice: z.boolean().default(false),
})

export const OrderBody = z.object({
  customerId: z.string().min(1),
  placedAt: z.string(),
  /** MAJOR units, customer currency, ex VAT. */
  shippingCharged: z.number().min(0).default(0),
  /**
   * MAJOR units, SHOP currency — it is a cost, and costs live there.
   *
   * Nullable, and NOT defaulted to 0: a stored zero wins outright in the engine
   * (`fulfillmentCost ?? perSku` short-circuits on it), so an order saved with
   * this box blank could never be costed by the per-SKU shipping rates, while
   * an imported order that leaves the column null is. "Shipping was free" and
   * "nobody said" have to be different values or the two populations of B2B
   * order are costed by different rules with nothing saying so.
   */
  fulfillmentCost: z.number().min(0).nullable().optional(),
  lines: z.array(Line).min(1),
})

export type OrderInput = z.infer<typeof OrderBody>

/**
 * Everything the database needs, derived here from what was typed.
 *
 * The browser's own totals are never trusted: they exist to show the user what
 * they are about to save, and nothing more. Throws RangeError carrying a
 * sentence worth showing when the input cannot make a real order.
 */
export async function buildOrderWrite(d: OrderInput) {
  const customer = await db.b2bCustomer.findUnique({ where: { id: d.customerId } })
  if (!customer) throw new RangeError('No such customer')

  const placedAt = utcDay(new Date(d.placedAt))
  if (Number.isNaN(placedAt.getTime())) throw new RangeError('That is not a date we can read')

  await assertProductsBelongToShop(customer.shopId, d.lines.map((l) => l.productId))

  for (const l of d.lines) {
    if (l.discountKind === 'PERCENT' && l.discountValue > 100)
      throw new RangeError('A percentage discount cannot be more than 100%')
    if (l.discountKind === 'AMOUNT' && l.discountValue > l.unitPrice)
      throw new RangeError('A discount cannot be more than the price of the item')
  }

  const products = await db.product.findMany({
    where: { id: { in: d.lines.map((l) => l.productId) } },
    select: { id: true, sku: true, name: true },
  })
  const byId = new Map(products.map((p) => [p.id, p]))

  const lines: B2bLine[] = d.lines.map((l) => ({
    quantity: l.quantity,
    unitPrice: toMinor(l.unitPrice),
    // A percentage is a plain number; an amount is money and becomes minor units.
    discountValue: l.discountKind === 'PERCENT' ? l.discountValue : toMinor(l.discountValue),
    discountKind: l.discountKind,
  }))

  return {
    customer,
    placedAt,
    totals: orderTotals(lines, toMinor(d.shippingCharged), customer.vatPercent),
    // As OrderItem holds a line: unitPrice BEFORE discount and lineNetTotal
    // after, exactly as mapOrder() stores a WooCommerce line.
    items: d.lines.map((l, i) => ({
      productId: l.productId,
      sku: byId.get(l.productId)?.sku ?? '',
      name: byId.get(l.productId)?.name ?? '',
      quantity: l.quantity,
      unitPrice: lines[i].unitPrice,
      lineNetTotal: lineTotals(lines[i]).net,
      discountValue: lines[i].discountValue,
      discountKind: l.discountKind,
    })),
    // Only the ticked ones become standing prices; editing a prefilled price
    // without ticking is a one-off for this order.
    pricesToSave: d.lines
      .map((l, i) => ({ save: l.savePrice, productId: l.productId, unitPrice: lines[i].unitPrice }))
      .filter((p) => p.save),
  }
}

/**
 * What goes in the column: minor units, or null when nobody said.
 *
 * Shared with PATCH so an edit cannot disagree with a create about which of the
 * two "blank" means.
 */
export function fulfillmentCostToStore(typed: number | null | undefined): number | null {
  return typed === null || typed === undefined ? null : toMinor(typed)
}

/** Write the ticked prices. Shared with PATCH, which does the same on edit. */
export async function saveStandingPrices(
  tx: Prisma.TransactionClient,
  customerId: string,
  prices: { productId: string; unitPrice: number }[],
): Promise<void> {
  for (const p of prices) {
    await tx.b2bPrice.upsert({
      where: { customerId_productId: { customerId, productId: p.productId } },
      create: { customerId, productId: p.productId, unitPrice: p.unitPrice },
      update: { unitPrice: p.unitPrice },
    })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = OrderBody.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid order' }, { status: 400, headers: NO_STORE })

    const w = await buildOrderWrite(parsed.data)

    // Two saves racing collide on @@unique([shopId, externalId]). One retry is
    // enough for a double-click, which is the only way this happens here.
    for (let attempt = 0; attempt < 2; attempt++) {
      const number = await nextB2bNumber(w.customer.shopId)
      try {
        const order = await db.$transaction(async (tx) => {
          const created = await tx.order.create({
            data: {
              shopId: w.customer.shopId,
              externalId: b2bExternalId(number),
              number,
              placedAt: w.placedAt,
              // It happened, so it earns from now. An edit can void it later
              // and EXCLUDED_STATUSES zeroes it with no special case.
              status: 'completed',
              currency: w.customer.currency,
              grossSales: w.totals.grossSales,
              discountTotal: w.totals.discountTotal,
              netSales: w.totals.netSales,
              shippingCharged: w.totals.shippingCharged,
              taxTotal: w.totals.taxTotal,
              total: w.totals.total,
              couponCode: null,
              ambassadorId: null,
              // Not null: it keeps this order out of backfillCustomers()' queue
              // and lets the Orders search find the customer by name.
              customerName: w.customer.name,
              customerEmail: w.customer.email ?? '',
              b2bCustomerId: w.customer.id,
              fulfillmentCost: fulfillmentCostToStore(parsed.data.fulfillmentCost),
              items: { create: w.items },
            },
            select: { id: true, number: true },
          })

          await saveStandingPrices(tx, w.customer.id, w.pricesToSave)
          return created
        })

        return NextResponse.json({ order }, { headers: NO_STORE })
      } catch (e) {
        // Any attempt may race a collision, not just the first — the loop
        // bound above (attempt < 2) is what caps the retries. Gating this on
        // attempt === 0 left a second collision to re-throw uncaught into the
        // generic 500 below, when it should fall through to the honest 409.
        const raced = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
        if (!raced) throw e
      }
    }

    return NextResponse.json(
      { error: 'Could not pick an order number. Try again.' },
      { status: 409, headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the order' }, { status: 500, headers: NO_STORE })
  }
}
