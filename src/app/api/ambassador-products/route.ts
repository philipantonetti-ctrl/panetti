import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { utcDay } from '@/lib/dates'
import { summariseProducts } from '@/lib/ambassador-products'

/**
 * What we sent our ambassadors: the overview, and the door to add one.
 *
 * GET answers with BOTH the per-product counts and the picker's catalogue, so
 * the ambassadors page makes one request instead of two for the same screen.
 *
 * Staff, not admin: marketing runs the ambassador program, exactly as they do
 * for codes and rates.
 */

export async function GET() {
  try {
    assertStaff(await currentUser())

    const [gifts, products] = await Promise.all([
      db.ambassadorProduct.findMany({
        select: { ambassadorId: true, sku: true, name: true, quantity: true },
      }),
      // Ordered so the name a duplicated SKU ends up with is decided by the
      // data, not by whatever order Postgres felt like returning. Product has
      // no updatedAt, so "the most recent name" is not available to us and is
      // not invented here.
      db.product.findMany({ select: { sku: true, name: true }, orderBy: { name: 'asc' } }),
    ])

    // One entry per SKU: the same physical product is a separate Product row in
    // every shop that ever sold it, and the picker must offer it once.
    const catalogue: { sku: string; name: string }[] = []
    const seen = new Set<string>()
    for (const p of products) {
      if (seen.has(p.sku)) continue
      seen.add(p.sku)
      catalogue.push({ sku: p.sku, name: p.name })
    }

    return NextResponse.json({ overview: summariseProducts(gifts), catalogue })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the products' }, { status: 500 })
  }
}

const Body = z.object({
  ambassadorId: z.string().min(1),
  sku: z.string().trim().min(1, 'Pick a product'),
  name: z.string().trim().min(1, 'Pick a product'),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  receivedAt: z.string().min(1, 'Pick the date they got it'),
  note: z.string().trim().max(200, 'Keep the note under 200 characters').optional(),
})

export async function POST(req: Request) {
  try {
    assertStaff(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the values' },
        { status: 400 },
      )
    }
    const d = parsed.data

    const received = new Date(d.receivedAt)
    if (Number.isNaN(received.getTime())) {
      return NextResponse.json({ error: 'Pick the date they got it' }, { status: 400 })
    }

    // A friendlier answer than a raw foreign-key failure.
    const ambassador = await db.ambassador.findUnique({
      where: { id: d.ambassadorId },
      select: { id: true },
    })
    if (!ambassador) return NextResponse.json({ error: 'No such ambassador' }, { status: 404 })

    await db.ambassadorProduct.create({
      data: {
        ambassadorId: d.ambassadorId,
        sku: d.sku,
        name: d.name,
        quantity: d.quantity,
        // UTC midnight, the convention every dated value here follows.
        receivedAt: utcDay(received),
        note: d.note || null,
      },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the product' }, { status: 500 })
  }
}
