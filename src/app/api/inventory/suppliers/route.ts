// src/app/api/inventory/suppliers/route.ts
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

export async function GET() {
  return guard(async () =>
    NextResponse.json(
      await db.supplier.findMany({ orderBy: { name: 'asc' } }),
      { headers: NO_STORE },
    ),
  )
}

export async function POST(req: Request) {
  return guard(async () => {
    const body = (await req.json()) as { name?: string; notes?: string }
    const name = (body.name ?? '').trim()
    // A blank name makes a row nobody can identify later, and nothing else in
    // the app can repair it.
    if (!name) return fail('A supplier needs a name', 400)

    const supplier = await db.supplier.create({ data: { name, notes: body.notes ?? null } })
    return NextResponse.json(supplier, { headers: NO_STORE })
  })
}

export async function DELETE(req: Request) {
  return guard(async () => {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return fail('Which supplier?', 400)
    // Its products are unassigned by the schema's SetNull; their purchase
    // history survives, because it records what actually happened.
    await db.supplier.delete({ where: { id } })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  })
}
