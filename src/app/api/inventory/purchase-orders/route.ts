import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: NO_STORE })

const guard = async (fn: () => Promise<NextResponse>) => {
  try {
    assertAdmin(await currentUser())
    return await fn()
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message, 403)
    console.error(e)
    return fail('Could not save', 500)
  }
}

const date = (v: unknown): Date | null => {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * A quantity, or null if it is not one. Strict about type on purpose: `Number(true)`
 * is 1, so a bare cast would silently turn a malformed request into an order for a
 * single unit. Matches the strictness of `whole()` in the items route.
 */
function positiveWhole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

export async function GET() {
  return guard(async () =>
    NextResponse.json(
      await db.purchaseOrder.findMany({
        orderBy: { orderedAt: 'desc' },
        include: { item: { select: { sku: true, name: true } } },
      }),
      { headers: NO_STORE },
    ),
  )
}

export async function POST(req: Request) {
  return guard(async () => {
    const b = (await req.json()) as Record<string, unknown>
    const quantity = positiveWhole(b.quantity)
    if (quantity === null) return fail('How many units?', 400)
    const orderedAt = date(b.orderedAt)
    if (!orderedAt) return fail('When was it ordered?', 400)
    if (!b.supplyItemId) return fail('Which product?', 400)

    const order = await db.purchaseOrder.create({
      data: {
        supplyItemId: String(b.supplyItemId),
        quantity,
        orderedAt,
        // Null is allowed and honest. An order with no ETA is shown on the
        // forecast row but never moves a run-out date.
        eta: date(b.eta),
        notes: (b.notes as string | null) ?? null,
      },
    })
    return NextResponse.json(order, { headers: NO_STORE })
  })
}

export async function PUT(req: Request) {
  return guard(async () => {
    const b = (await req.json()) as Record<string, unknown>
    if (!b.id) return fail('Which order?', 400)

    const data: Record<string, unknown> = {}
    if ('eta' in b) data.eta = date(b.eta)
    if ('receivedAt' in b) data.receivedAt = date(b.receivedAt)
    if ('notes' in b) data.notes = (b.notes as string | null) ?? null
    if ('quantity' in b) {
      const quantity = positiveWhole(b.quantity)
      if (quantity === null) return fail('How many units?', 400)
      data.quantity = quantity
    }

    const order = await db.purchaseOrder.update({ where: { id: String(b.id) }, data })
    return NextResponse.json(order, { headers: NO_STORE })
  })
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail('Which order?', 400)
    await db.purchaseOrder.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  })
}
