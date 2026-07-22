import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { signInvite } from '@/lib/auth/invite'
import { db } from '@/lib/db'

const Body = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  // The admin types a PERCENT. The column holds a FRACTION. Converted once, here.
  commissionPercent: z.number().min(0).max(100),
  shopId: z.string().min(1),
  code: z.string().min(1),
})

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function GET() {
  try {
    assertAdmin(await currentUser())

    const rows = await db.ambassador.findMany({
      include: {
        codes: { include: { shop: { select: { name: true } } } },
        user: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const ambassadors = await Promise.all(
      rows.map(async (a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        commissionPercent: Math.round(a.commissionRate * 10000) / 100,
        active: a.active,
        codes: a.codes.map((c) => ({ id: c.id, code: c.code, shopId: c.shopId, shopName: c.shop.name })),
        onboarded: a.user !== null,
        // Never mint a link for someone who already has a login.
        invitePath: a.user ? null : `/invite/${await signInvite(a.id)}`,
      })),
    )

    return NextResponse.json({ ambassadors })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load ambassadors' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Check the name, email, rate and code' }, { status: 400 })
    }
    const { name, email, commissionPercent, shopId, code } = parsed.data

    // A friendlier answer than a raw foreign-key failure if the store is gone.
    const shop = await db.shop.findUnique({ where: { id: shopId } })
    if (!shop) return NextResponse.json({ error: 'Pick a valid store for the code' }, { status: 400 })

    const ambassador = await db.ambassador.create({
      data: {
        name,
        email: email.toLowerCase(),
        commissionRate: commissionPercent / 100,
        codes: { create: { code: code.toUpperCase(), shopId } },
      },
    })

    return NextResponse.json({ ok: true, id: ambassador.id })
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
