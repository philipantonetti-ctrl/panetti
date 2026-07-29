import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { hashPassword } from '@/lib/auth/password'
import { db } from '@/lib/db'

/**
 * Staff logins — Admin and Marketing. Ambassador logins never appear here:
 * they are minted by invites and die with their ambassador.
 */

const STAFF_ROLES = ['ADMIN', 'MARKETING'] as const

const Body = z.object({
  email: z.string().email('Enter a real email'),
  role: z.enum(STAFF_ROLES),
  password: z.string().min(8, 'Choose a starter password of at least 8 characters'),
})

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002'
}

export async function GET() {
  try {
    assertAdmin(await currentUser())
    const users = await db.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      select: { id: true, email: true, role: true },
      orderBy: { email: 'asc' },
    })
    return NextResponse.json({ users })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    return NextResponse.json({ error: 'Could not load the logins' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Check the email, role and password' },
        { status: 400 },
      )
    }
    const { email, role, password } = parsed.data

    const user = await db.user.create({
      data: { email: email.toLowerCase(), role, passwordHash: await hashPassword(password) },
    })
    return NextResponse.json({ ok: true, id: user.id })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: 'That email already has a login' }, { status: 409 })
    }
    console.error(e)
    return NextResponse.json({ error: 'Could not create the login' }, { status: 500 })
  }
}
