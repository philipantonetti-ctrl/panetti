import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { checkPassword, hashPassword } from '@/lib/auth/password'
import { checkNewPassword } from '@/lib/auth/account-rules'

const Body = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
  confirmPassword: z.string(),
})

/**
 * Change your own password.
 *
 * You must prove you know the current one first, so a borrowed, unattended screen
 * cannot be used to lock the real owner out of their account.
 */
export async function POST(req: Request) {
  try {
    const user = await currentUser()
    if (!user) throw new AuthError('Sign in first')

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

    const { currentPassword, newPassword, confirmPassword } = parsed.data

    const problem = checkNewPassword(currentPassword, newPassword, confirmPassword)
    if (problem) return NextResponse.json({ error: problem }, { status: 400 })

    const row = await db.user.findUniqueOrThrow({ where: { id: user.userId } })

    if (!(await checkPassword(currentPassword, row.passwordHash))) {
      return NextResponse.json({ error: 'Your current password is not right.' }, { status: 400 })
    }

    await db.user.update({
      where: { id: user.userId },
      data: { passwordHash: await hashPassword(newPassword) },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return NextResponse.json({ error: 'Could not change your password' }, { status: 500 })
  }
}
