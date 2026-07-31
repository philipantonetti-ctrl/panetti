import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertStaff, AuthError } from '@/lib/auth/guard'
import { signInvite } from '@/lib/auth/invite'
import { attributeExistingOrders } from '@/lib/attribution'
import { db } from '@/lib/db'
import { utcDay } from '@/lib/dates'

/**
 * One gift, described exactly as POST /api/ambassador-products describes it, so
 * both doors into the ledger accept and refuse the same things.
 */
const Gift = z.object({
  sku: z.string().trim().min(1, 'Pick a product'),
  name: z.string().trim().min(1, 'Pick a product'),
  // Optional and defaulted: the form no longer asks, because a gift is one
  // product and an ambassador who also got accessories ticks the accessories.
  quantity: z.number().int().min(1, 'Quantity must be at least 1').optional().default(1),
  receivedAt: z.string().min(1, 'Pick the date they got it'),
  note: z.string().trim().max(200, 'Keep the note under 200 characters').optional(),
})

const Body = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // The admin types a PERCENT. The column holds a FRACTION. Converted once, here.
  commissionPercent: z.number().min(0).max(100),
  shopId: z.string().min(1),
  code: z.string().min(1),
  // A sanity bound on a list assembled by hand, not a business rule.
  products: z.array(Gift).max(50, 'That is a lot of products for one person').optional(),
})

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function GET() {
  try {
    assertStaff(await currentUser())

    const rows = await db.ambassador.findMany({
      include: {
        codes: { include: { shop: { select: { name: true } } } },
        user: { select: { id: true } },
        // Newest first: what we sent most recently is what anyone is asking about.
        products: {
          orderBy: { receivedAt: 'desc' },
          select: { id: true, sku: true, name: true, quantity: true, receivedAt: true, note: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Which of these emails already have a login? Usually that is the owner, who
    // is an admin AND an ambassador on one email. They can never redeem an
    // invite (the email is taken), so we must not offer them one.
    const withLogin = new Set(
      (
        await db.user.findMany({
          where: { email: { in: rows.map((a) => a.email) } },
          select: { email: true },
        })
      ).map((u) => u.email),
    )

    const ambassadors = await Promise.all(
      rows.map(async (a) => {
        const emailHasLogin = withLogin.has(a.email)
        return {
          id: a.id,
          name: a.name,
          email: a.email,
          commissionPercent: Math.round(a.commissionRate * 10000) / 100,
          active: a.active,
          codes: a.codes.map((c) => ({ id: c.id, code: c.code, shopId: c.shopId, shopName: c.shop.name })),
          products: a.products.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            quantity: p.quantity,
            receivedAt: p.receivedAt.toISOString(),
            note: p.note,
          })),
          onboarded: a.user !== null,
          emailHasLogin,
          // Never mint a link that cannot be redeemed: already onboarded, or the
          // email belongs to a login already.
          invitePath: a.user || emailHasLogin ? null : `/invite/${await signInvite(a.id)}`,
        }
      }),
    )

    return NextResponse.json({ ambassadors })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load ambassadors' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertStaff(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      // The first issue's own message, because "Quantity must be at least 1"
      // tells you where to look and "Check the name, email, rate and code"
      // does not, now that products come through here too.
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the name, email, rate and code' },
        { status: 400 },
      )
    }
    const { name, email, commissionPercent, shopId, code, products } = parsed.data

    // A friendlier answer than a raw foreign-key failure if the store is gone.
    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'Pick a valid store for the code' }, { status: 400 })

    // Checked before the write, so an unreadable date is a 400 and not a row
    // holding Invalid Date.
    const gifts = (products ?? []).map((p) => ({ ...p, on: new Date(p.receivedAt) }))
    if (gifts.some((g) => Number.isNaN(g.on.getTime()))) {
      return NextResponse.json({ error: 'Pick the date they got it' }, { status: 400 })
    }

    // An email that already has a login (e.g. the admin's own) is deliberately
    // allowed: the same person can be an admin AND an ambassador. The code is
    // tracked without a separate ambassador login, and they see it on the
    // dashboard. Only onboarding (setting a second password) is skipped — the
    // invite route says so plainly if they ever open the link.

    // One nested write, not a create followed by N gift POSTs. A duplicate code
    // is a 409 the moment it is discovered, and this way it takes the gifts
    // down with it rather than leaving rows behind for an ambassador who was
    // never created.
    const ambassador = await db.ambassador.create({
      data: {
        name,
        email: email.toLowerCase(),
        commissionRate: commissionPercent / 100,
        codes: { create: { code: code.toUpperCase(), shopId } },
        ...(gifts.length > 0 && {
          products: {
            create: gifts.map((g) => ({
              sku: g.sku,
              name: g.name,
              quantity: g.quantity,
              // UTC midnight, the convention every dated value here follows.
              receivedAt: utcDay(g.on),
              note: g.note || null,
            })),
          },
        }),
      },
    })

    // Their code may already have months of sales behind it. Link those now, so
    // a new ambassador does not open an empty portal.
    const linked = await attributeExistingOrders(ambassador.id, shopId, code)

    return NextResponse.json({ ok: true, id: ambassador.id, linkedOrders: linked })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        { error: 'That email is taken, or that code already exists on that store' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'Could not create the ambassador' }, { status: 500 })
  }
}
