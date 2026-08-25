import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const STATUSES = new Set(['OPEN', 'PENDING', 'CLOSED'])
const PAGE = 100

/**
 * The queue. Filters are AND-ed; `q` searches the subject, the customer's
 * name and address, and a bare ticket number ("1042" or "PA-1042"). Message
 * bodies are deliberately not searched yet: at this scale a LIKE over every
 * email body is fine, but it turns "search" into "grep", and the queue's job
 * is finding a ticket, not a sentence.
 */
export async function GET(req: Request) {
  try {
    assertAdmin(await currentUser())
    const p = new URL(req.url).searchParams
    const status = p.get('status')
    const mailboxId = p.get('mailboxId')
    // 'none' = unassigned; a user id = theirs. "Me" is the client's business -
    // it knows its own id.
    const assignee = p.get('assigneeId')
    const q = p.get('q')?.trim() ?? ''
    const number = /^(?:PA-)?(\d+)$/i.exec(q)?.[1]

    const tickets = await db.ticket.findMany({
      where: {
        ...(status && STATUSES.has(status) ? { status } : {}),
        ...(mailboxId ? { mailboxId } : {}),
        ...(assignee === 'none' ? { assigneeUserId: null } : assignee ? { assigneeUserId: assignee } : {}),
        ...(q
          ? {
              OR: [
                { subject: { contains: q, mode: 'insensitive' } },
                { customerEmail: { contains: q, mode: 'insensitive' } },
                { customerName: { contains: q, mode: 'insensitive' } },
                ...(number ? [{ number: Number(number) }] : []),
              ],
            }
          : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: PAGE,
      include: { mailbox: { select: { address: true, name: true } }, assignee: { select: { id: true, email: true } } },
    })

    return NextResponse.json(
      {
        tickets: tickets.map((t) => ({
          id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority,
          customerEmail: t.customerEmail, customerName: t.customerName, tags: t.tags, category: t.category,
          language: t.language, mailbox: t.mailbox.address, mailboxName: t.mailbox.name,
          assignee: t.assignee ? { id: t.assignee.id, email: t.assignee.email } : null,
          lastMessageAt: t.lastMessageAt.toISOString(),
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the inbox' }, { status: 500, headers: NO_STORE })
  }
}
