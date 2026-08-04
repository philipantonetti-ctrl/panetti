import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { costOn } from '@/lib/metrics/costs'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'
import { assertProductsBelongToShop, Price } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({
  // Only honoured while the customer has no orders; see below.
  shopId: z.string().min(1).optional(),
  name: z.string().min(1),
  currency: z.string().length(3),
  vatPercent: z.number().min(0).max(100).default(0),
  email: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  active: z.boolean().default(true),
  prices: z.array(Price).default([]),
})

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const c = await db.b2bCustomer.findUnique({
      where: { id },
      include: {
        shop: { select: { name: true, currency: true } },
        prices: {
          include: {
            product: {
              select: {
                sku: true, name: true, imageUrl: true,
                costs: { orderBy: { effectiveFrom: 'desc' } },
              },
            },
          },
        },
      },
    })
    if (!c)
      return NextResponse.json({ error: 'No such customer' }, { status: 404, headers: NO_STORE })

    const totals = await db.order.aggregate({
      where: { b2bCustomerId: id, status: { notIn: [...EXCLUDED_STATUSES] } },
      _count: { _all: true },
      _sum: { netSales: true, shippingCharged: true },
    })
    // Any order at all locks the shop, not just an earning one — a refunded
    // order is still history reported under this store.
    const everOrdered = await db.order.count({ where: { b2bCustomerId: id } })
    const today = new Date()

    return NextResponse.json(
      {
        customer: {
          id: c.id,
          name: c.name,
          shopId: c.shopId,
          shopName: c.shop.name,
          shopCurrency: c.shop.currency,
          currency: c.currency,
          vatPercent: c.vatPercent,
          email: c.email,
          note: c.note,
          active: c.active,
          priceCount: c.prices.length,
          orderCount: totals._count._all,
          revenue: (totals._sum.netSales ?? 0) + (totals._sum.shippingCharged ?? 0),
          canChangeShop: everOrdered === 0,
          prices: c.prices.map((p) => {
            const cost = costOn(p.product.costs, today)
            return {
              productId: p.productId,
              sku: p.product.sku,
              name: p.product.name,
              imageUrl: p.product.imageUrl,
              // The agreed price is in the CUSTOMER's currency…
              unitPrice: p.unitPrice,
              // …and these two are in the SHOP's. The UI labels both columns.
              costPerItem: cost.costPerItem,
              handlingCost: cost.handlingCost,
            }
          }),
        },
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the customer' }, { status: 500, headers: NO_STORE })
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid customer' }, { status: 400, headers: NO_STORE })
    const d = parsed.data

    const existing = await db.b2bCustomer.findUnique({ where: { id } })
    if (!existing)
      return NextResponse.json({ error: 'No such customer' }, { status: 404, headers: NO_STORE })

    // Any order at all locks both the shop and the currency, not just an
    // earning one — a refunded order is still history recorded under them.
    const movingShop = d.shopId !== undefined && d.shopId !== existing.shopId
    const changingCurrency = d.currency.toUpperCase() !== existing.currency
    const hasOrders = (movingShop || changingCurrency)
      ? (await db.order.count({ where: { b2bCustomerId: id } })) > 0
      : false

    if (movingShop && hasOrders) {
      return NextResponse.json(
        { error: 'This customer already has orders, so their shop cannot be changed.' },
        { status: 400, headers: NO_STORE },
      )
    }
    if (changingCurrency && hasOrders) {
      return NextResponse.json(
        {
          error:
            'This customer already has orders in their current currency, so it cannot be changed.',
        },
        { status: 400, headers: NO_STORE },
      )
    }
    const shopId = movingShop ? d.shopId! : existing.shopId

    await assertProductsBelongToShop(shopId, d.prices.map((p) => p.productId))

    // Rewrite the price list rather than diff it — storeOrder()'s rule for
    // order lines, for the same reason: simpler and always right. Replacing a
    // price never touches an order already placed, because the price actually
    // charged is frozen on the OrderItem.
    await db.$transaction([
      db.b2bPrice.deleteMany({ where: { customerId: id } }),
      db.b2bCustomer.update({
        where: { id },
        data: {
          shopId,
          name: d.name.trim(),
          currency: d.currency.toUpperCase(),
          vatPercent: d.vatPercent,
          email: d.email?.trim() || null,
          note: d.note?.trim() || null,
          active: d.active,
          prices: {
            create: d.prices.map((p) => ({ productId: p.productId, unitPrice: toMinor(p.unitPrice) })),
          },
        },
      }),
    ])

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof RangeError)
      return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      return NextResponse.json(
        { error: 'That shop already has a customer with this name' },
        { status: 409, headers: NO_STORE },
      )
    console.error(e)
    return NextResponse.json({ error: 'Could not save the customer' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params

    // Deleting a customer must never take their orders with them. Deactivating
    // keeps every figure they contributed exactly where it is.
    if (await db.order.count({ where: { b2bCustomerId: id } })) {
      return NextResponse.json(
        { error: 'This customer has orders. Deactivate them instead.' },
        { status: 409, headers: NO_STORE },
      )
    }

    await db.b2bCustomer.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not delete the customer' }, { status: 500, headers: NO_STORE })
  }
}
