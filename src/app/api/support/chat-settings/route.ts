import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { fetchChatWidgets, gorgiasCredentials } from '@/lib/support/client'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The per-shop switch for live chat, and the two things Philip pastes into
 * Gorgias ONCE for the whole account: the webhook URL and the request body.
 * Shown verbatim so nothing is typed by hand.
 *
 * One URL, naming no shop. Gorgias fires an HTTP integration for every chat
 * widget of the account and has no rule action that triggers one, so a URL per
 * shop would answer every shop's chats as that shop. The webhook reads the
 * shop from the chat's widget instead, and this page is where each shop is
 * linked to its widget.
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

/** Gorgias names five widgets "Panetti"; the language is what tells them apart. */
const LANGUAGES: Record<string, string> = {
  da: 'Danish', no: 'Norwegian', nb: 'Norwegian', sv: 'Swedish', fi: 'Finnish', de: 'German', en: 'English',
}

async function widgets(): Promise<{ widgets: { id: string; label: string }[]; widgetsError: string | null }> {
  const creds = gorgiasCredentials()
  if (!creds) return { widgets: [], widgetsError: 'Gorgias is not connected, so its chat widgets cannot be listed.' }
  try {
    const found = await fetchChatWidgets(creds, Date.now() + 15_000)
    return {
      widgets: found.map((w) => ({
        id: w.id,
        label: w.language ? `${w.name}, ${LANGUAGES[w.language.slice(0, 2).toLowerCase()] ?? w.language}` : w.name,
      })),
      widgetsError: null,
    }
  } catch {
    return { widgets: [], widgetsError: 'Gorgias did not answer, so its chat widgets cannot be listed. Reload to try again.' }
  }
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const secret = process.env.GORGIAS_WEBHOOK_SECRET?.trim() ?? ''
    const [shops, listed] = await Promise.all([
      db.shop.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, aiChatFrom: true, gorgiasChatId: true },
      }),
      widgets(),
    ])
    return NextResponse.json(
      {
        secretConfigured: secret.length > 0,
        bodyTemplate: BODY_TEMPLATE,
        // No secret means no URL at all, rather than one that looks right
        // and is refused by the webhook the first time a customer writes.
        webhookUrl: secret ? `${appUrl()}/api/gorgias/webhook?token=${encodeURIComponent(secret)}` : null,
        ...listed,
        shops: shops.map((s) => ({
          id: s.id,
          name: s.name,
          aiChatFrom: s.aiChatFrom ? s.aiChatFrom.toISOString().slice(0, 10) : null,
          gorgiasChatId: s.gorgiasChatId,
        })),
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not load the chat settings' }, { status: 500, headers: NO_STORE })
  }
}

/** One thing at a time: the shop's widget, or the shop's date. */
const Body = z.union([
  z.object({ shopId: z.string().trim().min(1), widgetId: z.string().trim().regex(/^\d+$/).nullable() }).strict(),
  z.object({ shopId: z.string().trim().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).strict(),
])

export async function PUT(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'A shop with a chat widget, or a shop with a date' }, { status: 400, headers: NO_STORE })
    const { shopId } = parsed.data

    if ('widgetId' in parsed.data) {
      const { widgetId } = parsed.data
      if (widgetId) {
        const holder = await db.shop.findFirst({ where: { gorgiasChatId: widgetId, id: { not: shopId } }, select: { name: true } })
        if (holder) {
          return NextResponse.json({ error: `That chat widget already belongs to ${holder.name}.` }, { status: 409, headers: NO_STORE })
        }
      }
      // Unlinking also switches the chat off: a date with no widget would
      // look on and answer nobody.
      await db.shop.updateMany({
        where: { id: shopId },
        data: widgetId ? { gorgiasChatId: widgetId } : { gorgiasChatId: null, aiChatFrom: null },
      })
      return NextResponse.json({ ok: true }, { headers: NO_STORE })
    }

    const { date } = parsed.data
    if (date) {
      const shop = await db.shop.findUnique({ where: { id: shopId }, select: { gorgiasChatId: true } })
      if (shop && !shop.gorgiasChatId) {
        return NextResponse.json({ error: 'Choose this shop’s chat widget first.' }, { status: 400, headers: NO_STORE })
      }
    }
    // updateMany: a shop id that no longer exists is a no-op, not a failure.
    await db.shop.updateMany({
      where: { id: shopId },
      data: { aiChatFrom: date ? new Date(`${date}T00:00:00Z`) : null },
    })
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not save' }, { status: 500, headers: NO_STORE })
  }
}
