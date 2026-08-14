import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { ensureSupplyItems } from '@/lib/inventory/supply-items'
import { normaliseSku } from '@/lib/inventory/sku'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

/** Null clears a setting; a number must be a non-negative whole number. */
function whole(value: unknown, field: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: `${field} must be a whole number of 0 or more` }
  }
  return { ok: true, value }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    // Opening the page is the moment to make sure every product we sell has a
    // row, so the list is never empty and nobody types 63 SKUs.
    await ensureSupplyItems()
    return NextResponse.json(
      await db.supplyItem.findMany({
        orderBy: { name: 'asc' },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not load items', 500)
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const body = (await req.json()) as Record<string, unknown>
    const sku = normaliseSku(String(body.sku ?? ''))
    if (!sku) return fail('Which product?', 400)

    const fields = ['productionDays', 'deliveryDays', 'moq', 'unitsPerContainer', 'coverDays'] as const
    const data: Record<string, number | null | string> = {}
    for (const f of fields) {
      if (!(f in body)) continue
      const parsed = whole(body[f], f)
      if (!parsed.ok) return fail(parsed.error, 400)
      data[f] = parsed.value
    }
    if ('supplierId' in body) data.supplierId = (body.supplierId as string | null) ?? null

    const item = await db.supplyItem.update({ where: { sku }, data })
    return NextResponse.json(item, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not save', 500)
  }
}
