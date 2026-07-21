import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const rates = await db.fulfillmentRate.findMany({ orderBy: { effectiveFrom: 'desc' } })
    return NextResponse.json({
      rates: rates.map((r) => ({
        id: r.id,
        shopId: r.shopId,
        perOrder: r.perOrder,
        effectiveFrom: r.effectiveFrom.toISOString(),
      })),
    })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load fulfillment rates' }, { status: 500 })
  }
}

const Body = z.object({
  shopId: z.string().min(1),
  perOrder: z.number().min(0), // MAJOR units from the form; stored as minor
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

    const shop = await db.shop.findUnique({ where: { id: parsed.data.shopId } })
    if (!shop) return NextResponse.json({ error: 'No such shop' }, { status: 404 })

    await db.fulfillmentRate.create({
      data: {
        shopId: parsed.data.shopId,
        perOrder: Math.round(parsed.data.perOrder * 100),
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
    const existing = await db.fulfillmentRate.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'No such rate' }, { status: 404 })

    await db.fulfillmentRate.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not delete the rate' }, { status: 500 })
  }
}
