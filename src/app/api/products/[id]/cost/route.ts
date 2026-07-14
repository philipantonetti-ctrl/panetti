import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { toMinor } from '@/lib/money'
import { applyCostChange, resolveEffectiveFrom, type ApplyFrom } from '@/lib/cost-timeline'

const Apply = z.object({
  apply: z.enum(['FUTURE', 'LAST_60_DAYS', 'DATE_RANGE']),
  from: z.string().optional(),
})

const Body = z.object({
  costPerItem: z.number().min(0),
  costApply: Apply, // step 1 of 2 — when the new COGS starts applying
  handlingCost: z.number().min(0),
  handlingApply: Apply, // step 2 of 2 — when the new handling cost starts applying
})

/**
 * Save a product's costs.
 *
 * COGS and handling are chosen in two steps and can each start from a DIFFERENT date,
 * so we rebuild the product's cost timeline rather than overwrite it: every earlier
 * order keeps exactly the cost it already had.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAdmin(await currentUser())

    const { id } = await params
    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid cost' }, { status: 400 })

    const product = await db.product.findUnique({ where: { id } })
    if (!product) return NextResponse.json({ error: 'No such product' }, { status: 404 })

    const existing = await db.productCost.findMany({
      where: { productId: id },
      orderBy: { effectiveFrom: 'asc' },
    })

    const today = new Date()
    const rows = applyCostChange(
      existing.map((c) => ({
        costPerItem: c.costPerItem,
        handlingCost: c.handlingCost,
        effectiveFrom: c.effectiveFrom,
      })),
      {
        costPerItem: toMinor(parsed.data.costPerItem),
        costFrom: resolveEffectiveFrom(parsed.data.costApply as ApplyFrom, today),
        handlingCost: toMinor(parsed.data.handlingCost),
        handlingFrom: resolveEffectiveFrom(parsed.data.handlingApply as ApplyFrom, today),
      },
    )

    // Rewrite the timeline as one unit, so a half-written history can never be read.
    await db.$transaction([
      db.productCost.deleteMany({ where: { productId: id } }),
      db.productCost.createMany({
        data: rows.map((r) => ({
          productId: id,
          costPerItem: r.costPerItem,
          handlingCost: r.handlingCost,
          effectiveFrom: r.effectiveFrom,
        })),
      }),
    ])

    return NextResponse.json({ ok: true, points: rows.length })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the cost' }, { status: 500 })
  }
}
