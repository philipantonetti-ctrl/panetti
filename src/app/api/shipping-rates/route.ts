import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { isUsableSku, normaliseSku } from '@/lib/inventory/sku'

/**
 * What one unit of a SKU costs us to ship. The per-SKU half of /api/fulfillment,
 * which this deliberately mirrors verb for verb - same admin guard, same
 * major-units-in / minor-units-stored contract, same delete-by-query-id.
 */
export async function GET() {
  try {
    assertAdmin(await currentUser())
    const rates = await db.shippingRate.findMany({ orderBy: { effectiveFrom: 'desc' } })
    return NextResponse.json({
      rates: rates.map((r) => ({
        id: r.id,
        sku: r.sku,
        perUnit: r.perUnit,
        currency: r.currency,
        effectiveFrom: r.effectiveFrom.toISOString(),
      })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load shipping rates' }, { status: 500 })
  }
}

const Body = z.object({
  sku: z.string().min(1, 'Enter a SKU'),
  perUnit: z.number().min(0), // MAJOR units from the form; stored as minor
  /**
   * Named per row, unlike FulfillmentRate: a SKU is not shop-scoped, so there is
   * no shop currency for the rate to inherit. Three letters because a rate is
   * only in force for an order whose costs are held in the SAME currency, and
   * that comparison is against an ISO code - "kroner" would simply never match.
   */
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code like NOK'),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a from date'),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the values' },
        { status: 400 },
      )
    }

    // Six live products carry the SKU "0", spanning a pizza oven and a massage
    // chair. A shipping rate typed against a key like that would charge one
    // product's shipping to a completely different one, silently, on every order
    // either appears in. Blank fails the same test for the same reason.
    if (!isUsableSku(parsed.data.sku)) {
      return NextResponse.json(
        { error: 'That SKU does not identify one product' },
        { status: 400 },
      )
    }

    await db.shippingRate.create({
      data: {
        // Stored normalised, not as typed: the resolver looks a rate up by
        // normaliseSku, so a row kept as " panpizpro " would never be found.
        sku: normaliseSku(parsed.data.sku),
        perUnit: Math.round(parsed.data.perUnit * 100),
        currency: parsed.data.currency.toUpperCase(),
        effectiveFrom: new Date(parsed.data.effectiveFrom),
      },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the rate' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    assertAdmin(await currentUser())

    const id = new URL(req.url).searchParams.get('id') ?? ''
    const existing = await db.shippingRate.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such rate' }, { status: 404 })

    await db.shippingRate.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not delete the rate' }, { status: 500 })
  }
}
