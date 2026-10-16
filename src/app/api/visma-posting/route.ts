import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const MODES = ['off', 'dry_run', 'hold'] as const
const FIELDS = ['vismaCustomer', 'vismaClearingAccount', 'vismaBankAccount', 'vismaFeeAccount'] as const
type Field = (typeof FIELDS)[number]

/** Visma customer and account numbers are digits. Empty = not set. */
function clean(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  const s = String(v ?? '').trim()
  if (s === '') return null
  return /^\d{1,10}$/.test(s) ? s : undefined
}

async function state() {
  const config = await db.vismaPostingConfig.findUnique({ where: { id: 'singleton' } })
  const configs = await db.dinteroConfig.findMany({
    include: { shop: { select: { name: true, currency: true } } },
    orderBy: { shop: { name: 'asc' } },
  })
  return {
    mode: config?.mode ?? 'off',
    shops: configs.map((c) => ({
      shopId: c.shopId,
      name: c.shop.name,
      currency: c.shop.currency,
      vismaCustomer: c.vismaCustomer,
      vismaClearingAccount: c.vismaClearingAccount,
      vismaBankAccount: c.vismaBankAccount,
      vismaFeeAccount: c.vismaFeeAccount,
    })),
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    return NextResponse.json(await state(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the Visma posting settings' }, { status: 500, headers: NO_STORE })
  }
}

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const body = (await req.json().catch(() => null)) as { mode?: unknown; shops?: unknown } | null
    const mode = String(body?.mode ?? '')
    if (!(MODES as readonly string[]).includes(mode)) {
      return NextResponse.json({ error: 'Mode must be off, dry_run or hold' }, { status: 400, headers: NO_STORE })
    }
    const shops = Array.isArray(body?.shops) ? (body!.shops as Record<string, unknown>[]) : []
    const updates: { shopId: string; data: Partial<Record<Field, string | null>> }[] = []
    for (const s of shops) {
      const data: Partial<Record<Field, string | null>> = {}
      for (const f of FIELDS) {
        if (!(f in s)) continue
        const v = clean(s[f])
        if (v === undefined) {
          return NextResponse.json({ error: `${f} must be a number` }, { status: 400, headers: NO_STORE })
        }
        data[f] = v
      }
      updates.push({ shopId: String(s.shopId ?? ''), data })
    }
    // A shop whose mapping really changes gets its failed postings' attempts back, so a
    // corrected customer or account number is retried instead of staying given up on.
    const current = await db.dinteroConfig.findMany({ where: { shopId: { in: updates.map((u) => u.shopId) } } })
    const changed = updates
      .filter((u) => {
        const c = current.find((x) => x.shopId === u.shopId)
        return c !== undefined && FIELDS.some((f) => f in u.data && u.data[f] !== c[f])
      })
      .map((u) => u.shopId)
    await db.$transaction([
      db.vismaPostingConfig.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', mode }, update: { mode } }),
      ...updates.map((u) => db.dinteroConfig.updateMany({ where: { shopId: u.shopId }, data: u.data })),
      ...(changed.length > 0
        ? [db.vismaPosting.updateMany({ where: { status: 'error', payout: { shopId: { in: changed } } }, data: { attempts: 0 } })]
        : []),
    ])
    return NextResponse.json(await state(), { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the Visma posting settings' }, { status: 500, headers: NO_STORE })
  }
}
