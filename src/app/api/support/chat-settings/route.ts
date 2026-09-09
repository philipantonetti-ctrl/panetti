import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The per-shop switch for live chat, and the two things Philip pastes into
 * Gorgias for each shop: the webhook URL and the request body. Shown verbatim
 * so nothing is typed by hand.
 *
 * EVERY variable below is one Gorgias documents (their macro-variables
 * reference): ticket.id, ticket.channel, ticket.created_datetime,
 * ticket.customer.email, ticket.customer.firstname, ticket.subject.
 *
 * What is deliberately NOT here is the message itself - its id, its text, and
 * whether an agent wrote it. Gorgias documents no `message` scope for an HTTP
 * integration: their macro reference says outright that it does not document
 * `from_agent`, and the HTTP-integration pages only ever show
 * `{{ticket.customer.email}}`. A template pasted by hand is never tested until
 * a real customer writes, and `from_agent` is the field that stops the
 * assistant answering its own messages - so a wrong guess there is an
 * assistant talking to itself in a live chat window.
 *
 * The webhook therefore reads the message from the API instead:
 * `GET /api/messages?ticket_id=…&order_by=created_datetime:desc`, whose
 * TicketMessage object documents `id`, `body_text`, `from_agent` and `via`.
 * Ticket facts from the template, message facts from the API, and nothing
 * anywhere that Gorgias has not written down.
 */
export const BODY_TEMPLATE = `{
  "ticketId": "{{ticket.id}}",
  "channel": "{{ticket.channel}}",
  "ticketCreatedAt": "{{ticket.created_datetime}}",
  "customerEmail": "{{ticket.customer.email}}",
  "customerName": "{{ticket.customer.firstname}}",
  "subject": "{{ticket.subject}}"
}`

const appUrl = () => (process.env.APP_URL ?? 'https://panetti.vercel.app').replace(/\/$/, '')

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const secret = process.env.GORGIAS_WEBHOOK_SECRET?.trim() ?? ''
    const shops = await db.shop.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, aiChatFrom: true },
    })
    return NextResponse.json(
      {
        secretConfigured: secret.length > 0,
        bodyTemplate: BODY_TEMPLATE,
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          aiChatFrom: s.aiChatFrom ? s.aiChatFrom.toISOString().slice(0, 10) : null,
          // No secret means no URL at all, rather than one that looks right
          // and is refused by the webhook the first time a customer writes.
          webhookUrl: secret
            ? `${appUrl()}/api/gorgias/webhook?token=${encodeURIComponent(secret)}&shop=${encodeURIComponent(s.id)}`
            : null,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load the chat settings' }, { status: 500, headers: NO_STORE })
  }
}

const Body = z.object({
  shopId: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
})

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A shop and a date, or no date' }, { status: 400, headers: NO_STORE })
    // updateMany: a shop id that no longer exists is a no-op, not a failure.
    await db.shop.updateMany({
      where: { id: parsed.data.shopId },
      data: { aiChatFrom: parsed.data.date ? new Date(`${parsed.data.date}T00:00:00Z`) : null },
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
