import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { sendTestPickupReminder } from '@/lib/delivery/pickup-reminders'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const Body = z.object({ shopId: z.string().min(1) })

/**
 * Sends the pickup reminder for one shop to the admin pressing the button, so
 * the words and the sender are proven before any customer gets one. Postmark's
 * own refusal is passed through word for word: "Sender signature not
 * confirmed" is the whole answer, and a generic failure would hide it.
 */
export async function POST(req: Request) {
  let to: string
  try {
    const user = await currentUser()
    assertAdmin(user)
    to = user.email
  } catch (e) {
    const status = e instanceof AuthError ? 403 : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Not allowed' }, { status, headers: NO_STORE })
  }

  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Which shop?' }, { status: 400, headers: NO_STORE })
  }

  try {
    const { language, from } = await sendTestPickupReminder(parsed.data.shopId, to)
    return NextResponse.json({ ok: true, to, language, from }, { headers: NO_STORE })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not send the test email' },
      { status: 502, headers: NO_STORE },
    )
  }
}
