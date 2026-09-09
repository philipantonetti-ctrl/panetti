import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { runSandboxTurn, SandboxError } from '@/lib/support/sandbox'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
export const dynamic = 'force-dynamic'
/** A judge call plus the customer lookup; well inside this, but not instant. */
export const maxDuration = 60

/**
 * The practice room's one door. Admin only: this is the assistant speaking
 * in the company's voice, even if nobody outside hears it.
 */
const Body = z.object({
  shopId: z.string().trim().min(1),
  customerEmail: z.string().trim().email().nullable().optional().or(z.literal('')),
  sessionKey: z.string().trim().min(1).max(60),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(5000) }))
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === 'user' && m[m.length - 1].text.trim().length > 0, {
      message: 'The last message must be something the customer wrote.',
    }),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'The last message must be something the customer wrote.' }, { status: 400, headers: NO_STORE })
    }
    const result = await runSandboxTurn({
      shopId: parsed.data.shopId,
      customerEmail: parsed.data.customerEmail ? parsed.data.customerEmail.toLowerCase() : null,
      sessionKey: parsed.data.sessionKey,
      messages: parsed.data.messages,
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    if (e instanceof SandboxError) return NextResponse.json({ error: e.message }, { status: 400, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'The sandbox could not run that turn' }, { status: 500, headers: NO_STORE })
  }
}
