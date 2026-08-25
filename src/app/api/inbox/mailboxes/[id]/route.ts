import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { isUniqueViolation } from '../../macros/route'
import { MailboxBody } from '../route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

const Patch = MailboxBody.partial().extend({ active: z.boolean().optional() })

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const parsed = Patch.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'That change is not one a mailbox understands' }, { status: 400, headers: NO_STORE })
    const { id } = await params
    const updated = await db.mailbox.updateMany({ where: { id }, data: parsed.data })
    if (updated.count === 0) return NextResponse.json({ error: 'No such mailbox' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (isUniqueViolation(e)) return NextResponse.json({ error: 'That address is already connected' }, { status: 409, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not update the mailbox' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    // Tickets cascade with their mailbox, so removing one with history would
    // silently destroy conversations. Deactivate instead - the same refusal
    // an ambassador with sales gets.
    const tickets = await db.ticket.count({ where: { mailboxId: id } })
    if (tickets > 0) {
      return NextResponse.json(
        { error: `Deactivate instead - ${tickets} ticket${tickets === 1 ? '' : 's'} would lose their mailbox` },
        { status: 409, headers: NO_STORE },
      )
    }
    const removed = await db.mailbox.deleteMany({ where: { id } })
    if (removed.count === 0) return NextResponse.json({ error: 'No such mailbox' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not remove the mailbox' }, { status: 500, headers: NO_STORE })
  }
}
