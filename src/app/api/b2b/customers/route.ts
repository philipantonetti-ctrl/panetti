import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'

/** Admin-only financial JSON: no browser, proxy or CDN may ever replay it. */
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const Price = z.object({
  productId: z.string().min(1),
  unitPrice: z.number().min(0), // MAJOR units, as typed on the form
})

const Body = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3),
  vatPercent: z.number().min(0).max(100).default(0),
  email: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  prices: z.array(Price).default([]),
})

/**
 * Every product priced for a customer must belong to that customer's shop.
 * Without this a customer of the Norwegian store could be priced on the
 * Swedish catalogue, and the order form would sell it. The [id] route and the
 * order routes enforce the same rule through this one function.
 */
export async function assertProductsBelongToShop(
  shopId: string,
  productIds: string[],
): Promise<void> {
  const wanted = new Set(productIds)
  if (wanted.size === 0) return

  const found = await db.product.count({ where: { shopId, id: { in: [...wanted] } } })
  if (found !== wanted.size) {
    throw new RangeError('That product does not belong to this shop')
  }
}

export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())

    const shopId = new URL(req.url).searchParams.get('shopId')

    const rows = await db.b2bCustomer.findMany({
      where: shopId ? { shopId } : {},
      orderBy: { name: 'asc' },
      include: {
        shop: { select: { name: true } },
        _count: { select: { prices: true } },
      },
    })

    // Revenue and order count in one grouped read, not one query per customer.
    // Voided and unpaid orders are left out for the reason the engine leaves
    // them out: they earned nothing.
    const totals = await db.order.groupBy({
      by: ['b2bCustomerId'],
      where: {
        b2bCustomerId: { in: rows.map((r) => r.id) },
        status: { notIn: [...EXCLUDED_STATUSES] },
      },
      _count: { _all: true },
      _sum: { netSales: true, shippingCharged: true },
    })
    const byCustomer = new Map(totals.map((t) => [t.b2bCustomerId, t]))

    return NextResponse.json(
      {
        customers: rows.map((c) => {
          const t = byCustomer.get(c.id)
          return {
            id: c.id,
            name: c.name,
            shopId: c.shopId,
            shopName: c.shop.name,
            currency: c.currency,
            vatPercent: c.vatPercent,
            email: c.email,
            note: c.note,
            active: c.active,
            priceCount: c._count.prices,
            orderCount: t?._count._all ?? 0,
            // Net revenue in the customer's OWN currency — every one of their
            // orders is in it, so nothing here needs converting.
            revenue: (t?._sum.netSales ?? 0) + (t?._sum.shippingCharged ?? 0),
          }
        }),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load customers' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success)
      return NextResponse.json({ error: 'Invalid customer' }, { status: 400, headers: NO_STORE })
    const d = parsed.data

    await assertProductsBelongToShop(d.shopId, d.prices.map((p) => p.productId))

    // The customer and their price list land together or not at all.
    const customer = await db.b2bCustomer.create({
      data: {
        shopId: d.shopId,
        name: d.name.trim(),
        currency: d.currency.toUpperCase(),
        vatPercent: d.vatPercent,
        email: d.email?.trim() || null,
        note: d.note?.trim() || null,
        prices: {
          create: d.prices.map((p) => ({ productId: p.productId, unitPrice: toMinor(p.unitPrice) })),
        },
      },
      select: { id: true },
    })

    return NextResponse.json({ customer }, { headers: NO_STORE })
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
