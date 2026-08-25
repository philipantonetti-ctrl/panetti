import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { LANGUAGES } from '@/lib/inbox/classify'
import { isUniqueViolation } from '../macros/route'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const MailboxBody = z.object({
  address: z.string().trim().toLowerCase().regex(EMAIL, 'Enter a full email address'),
  name: z.string().trim().min(1).max(80),
  shopId: z.string().min(1).nullable().optional(),
  language: z.enum(LANGUAGES).default('en'),
  signature: z.string().max(2000).default(''),
})

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const mailboxes = await db.mailbox.findMany({
      orderBy: { name: 'asc' },
      include: { shop: { select: { id: true, name: true } }, _count: { select: { tickets: true } } },
    })
    return NextResponse.json(
      {
        mailboxes: mailboxes.map((m) => ({
          id: m.id, address: m.address, name: m.name, language: m.language, signature: m.signature,
          active: m.active, shop: m.shop, ticketCount: m._count.tickets,
        })),
        // Where the client forwards each address to. An env var, not a row:
        // it is a fact about the Postmark server, set once at deploy time.
        forwardingAddress: process.env.POSTMARK_INBOUND_ADDRESS ?? null,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the mailboxes' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = MailboxBody.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Enter a full email address and a name' }, { status: 400, headers: NO_STORE })
    const mailbox = await db.mailbox.create({ data: { ...parsed.data, shopId: parsed.data.shopId ?? null } })
    return NextResponse.json({ ok: true, mailbox }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (isUniqueViolation(e)) return NextResponse.json({ error: 'That address is already connected' }, { status: 409, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not add the address' }, { status: 500, headers: NO_STORE })
  }
}
