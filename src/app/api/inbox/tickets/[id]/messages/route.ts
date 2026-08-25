import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { addNote, sendTicketReply } from '@/lib/inbox/reply'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

const Body = z.object({ kind: z.enum(['reply', 'note']), text: z.string().trim().min(1).max(20000) })

export async function POST(req: Request, { params }: Ctx) {
  try {
    const user = await currentUser()
    assertAdmin(user)
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Write something first' }, { status: 400, headers: NO_STORE })
    const { id } = await params
    if (!(await db.ticket.findUnique({ where: { id }, select: { id: true } })))
      return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })

    if (parsed.data.kind === 'note') {
      const r = await addNote(id, user.userId, parsed.data.text)
      return NextResponse.json({ ok: true, ...r }, { headers: NO_STORE })
    }
    try {
      const r = await sendTicketReply(id, user.userId, parsed.data.text)
      return NextResponse.json({ ok: true, ...r }, { headers: NO_STORE })
    } catch (e) {
      // Postmark's own sentence ("Sender signature not confirmed", "POSTMARK_
      // SERVER_TOKEN is not set") is the one thing the agent can act on.
      const reason = e instanceof Error ? e.message : 'The email could not be sent'
      return NextResponse.json({ error: `Not sent: ${reason}` }, { status: 502, headers: NO_STORE })
    }
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the message' }, { status: 500, headers: NO_STORE })
  }
}
