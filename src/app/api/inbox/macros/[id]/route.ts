import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { isUniqueViolation, MacroBody, unknownVariable } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const parsed = MacroBody.partial().safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'That change is not one a macro understands' }, { status: 400, headers: NO_STORE })
    const unknown = parsed.data.body ? unknownVariable(parsed.data.body) : null
    if (unknown) return NextResponse.json({ error: `${unknown} is not a variable macros know` }, { status: 400, headers: NO_STORE })
    const { id } = await params
    const updated = await db.macro.updateMany({ where: { id }, data: parsed.data })
    if (updated.count === 0) return NextResponse.json({ error: 'No such macro' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (isUniqueViolation(e)) return NextResponse.json({ error: 'That macro already exists in that language' }, { status: 409, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not update the macro' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const removed = await db.macro.deleteMany({ where: { id } })
    if (removed.count === 0) return NextResponse.json({ error: 'No such macro' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the macro' }, { status: 500, headers: NO_STORE })
  }
}
