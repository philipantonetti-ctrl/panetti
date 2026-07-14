import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { utcDay } from '@/lib/dates'

const Body = z.object({
  costPerItem: z.number().min(0),
  handlingCost: z.number().min(0),
  effectiveFrom: z.string(), // yyyy-mm-dd
})

/**
 * Saving a cost APPENDS a new point on the product's cost timeline — it never
 * overwrites history. Orders before `effectiveFrom` keep the cost they had.
 *
 * Saving twice for the same day updates that day's point rather than stacking
 * duplicates on it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())

    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid cost' }, { status: 400 })

    const product = await db.product.findUnique({ where: { id } })
    if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })

    const day = utcDay(new Date(parsed.data.effectiveFrom))
    if (Number.isNaN(day.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }

    const costPerItem = toMinor(parsed.data.costPerItem)
    const handlingCost = toMinor(parsed.data.handlingCost)

    const existing = await db.productCost.findFirst({
      where: { productId: id, effectiveFrom: day },
    })

    if (existing) {
      await db.productCost.update({
        where: { id: existing.id },
        data: { costPerItem, handlingCost },
      })
    } else {
      await db.productCost.create({
        data: { productId: id, costPerItem, handlingCost, effectiveFrom: day },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not save the cost' }, { status: 500 })
  }
}
