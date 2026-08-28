import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const body = (await req.json().catch(() => null)) as
      | { active?: boolean; title?: string; body?: string }
      | null
    if (!body) return NextResponse.json({ error: 'Nothing to change' }, { status: 400, headers: NO_STORE })

    const { id } = await params
    const updated = await db.knowledgeItem.updateMany({
      where: { id },
      data: {
        ...(typeof body.active === 'boolean' ? { active: body.active } : {}),
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
        ...(body.body?.trim() ? { body: body.body.trim() } : {}),
      },
    })
    if (updated.count === 0) return NextResponse.json({ error: 'No such entry' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not change it' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const removed = await db.knowledgeItem.deleteMany({ where: { id } })
    if (removed.count === 0) return NextResponse.json({ error: 'No such entry' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not remove it' }, { status: 500, headers: NO_STORE })
  }
}
