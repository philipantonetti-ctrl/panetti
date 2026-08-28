import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'

/**
 * The kinds a person can file knowledge under.
 *
 * The first four and the two rules are what the assistant is sent on EVERY
 * ticket; the rest is matched to the question. That difference is the reason
 * the kind is chosen rather than free text.
 */
export const KINDS = [
  'tone',
  'instruction',
  'never_say',
  'always_escalate',
  'faq',
  'policy',
  'product',
  'troubleshooting',
  'example',
] as const

const Body = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  shopId: z.string().trim().nullable().optional(),
  country: z.string().trim().max(2).nullable().optional(),
  language: z.string().trim().max(5).nullable().optional(),
  sku: z.string().trim().max(60).nullable().optional(),
})

/** An empty select means "everywhere", which is null in the table. */
const blankToNull = (v: string | null | undefined) => (v ? v : null)

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const [items, shops] = await Promise.all([
      db.knowledgeItem.findMany({
        orderBy: [{ kind: 'asc' }, { title: 'asc' }],
        include: { shop: { select: { name: true } } },
      }),
      db.shop.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ])
    return NextResponse.json(
      {
        items: items.map((i) => ({
          id: i.id, kind: i.kind, title: i.title, body: i.body, active: i.active,
          shopId: i.shopId, shopName: i.shop?.name ?? null,
          country: i.country, language: i.language, sku: i.sku,
        })),
        shops,
        kinds: KINDS,
      },
      { headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not load the knowledge base' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A knowledge entry needs a kind, a title and a body' },
        { status: 400, headers: NO_STORE },
      )
    }
    const d = parsed.data
    const item = await db.knowledgeItem.create({
      data: {
        kind: d.kind,
        title: d.title,
        body: d.body,
        shopId: blankToNull(d.shopId),
        country: blankToNull(d.country)?.toUpperCase() ?? null,
        language: blankToNull(d.language),
        sku: blankToNull(d.sku),
      },
    })
    return NextResponse.json({ ok: true, item }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save it' }, { status: 500, headers: NO_STORE })
  }
}
