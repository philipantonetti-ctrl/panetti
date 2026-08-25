import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { customerContext } from '@/lib/inbox/context'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

const Patch = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
  assigneeUserId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  matchedOrderId: z.string().min(1).nullable().optional(),
})

export async function GET(_req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const { id } = await params
    const t = await db.ticket.findUnique({
      where: { id },
      include: {
        mailbox: { select: { id: true, address: true, name: true, language: true, shopId: true } },
        assignee: { select: { id: true, email: true } },
        matchedOrder: { select: { id: true, number: true } },
        messages: {
          orderBy: { sentAt: 'asc' },
          include: { author: { select: { email: true } }, attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true } } },
        },
      },
    })
    if (!t) return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })

    const context = await customerContext(t.customerEmail, t.id)
    return NextResponse.json(
      {
        ticket: {
          id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, tags: t.tags,
          category: t.category, language: t.language ?? t.mailbox.language, languageDetected: t.language !== null,
          customerEmail: t.customerEmail, customerName: t.customerName,
          mailbox: t.mailbox, assignee: t.assignee, matchedOrder: t.matchedOrder,
          firstMessageAt: t.firstMessageAt.toISOString(), lastMessageAt: t.lastMessageAt.toISOString(),
        },
        messages: t.messages.map((m) => ({
          id: m.id, direction: m.direction, author: m.author?.email ?? null, fromEmail: m.fromEmail, toEmail: m.toEmail,
          // The thread shows the customer's new words, not the quoted history
          // beneath them; the full text is one click away.
          text: m.direction === 'INBOUND' ? (m.strippedReply || m.textBody) : m.textBody,
          fullText: m.textBody, hasHtml: m.htmlBody !== null, spamScore: m.spamScore,
          sentAt: m.sentAt.toISOString(), attachments: m.attachments,
        })),
        context,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the ticket' }, { status: 500, headers: NO_STORE })
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const parsed = Patch.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'That change is not one the ticket understands' }, { status: 400, headers: NO_STORE })
    const { id } = await params
    const d = parsed.data
    const updated = await db.ticket.updateMany({
      where: { id },
      data: {
        ...(d.status ? { status: d.status, closedAt: d.status === 'CLOSED' ? new Date() : null } : {}),
        ...(d.priority ? { priority: d.priority } : {}),
        ...(d.assigneeUserId !== undefined ? { assigneeUserId: d.assigneeUserId } : {}),
        ...(d.tags ? { tags: [...new Set(d.tags)] } : {}),
        ...(d.matchedOrderId !== undefined ? { matchedOrderId: d.matchedOrderId } : {}),
      },
    })
    if (updated.count === 0) return NextResponse.json({ error: 'No such ticket' }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not update the ticket' }, { status: 500, headers: NO_STORE })
  }
}
