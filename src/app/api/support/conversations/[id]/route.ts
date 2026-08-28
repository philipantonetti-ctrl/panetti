import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Ctx = { params: Promise<{ id: string }> }

const Body = z.object({
  rating: z.enum(['good', 'bad']).nullable().optional(),
  correction: z.string().max(8000).nullable().optional(),
})

/**
 * A person's verdict on one answer.
 *
 * A correction is not a note to ourselves: it is what the answer SHOULD have
 * said, which is the raw material for teaching the assistant without anyone
 * retraining a model. Kept beside the question it belongs to.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    assertAdmin(await currentUser())
    const parsed = Body.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Nothing to record' }, { status: 400, headers: NO_STORE })

    const { id } = await params
    const updated = await db.aiConversation.updateMany({
      where: { id },
      data: {
        ...(parsed.data.rating !== undefined ? { rating: parsed.data.rating } : {}),
        ...(parsed.data.correction !== undefined
          ? { correction: parsed.data.correction?.trim() || null }
          : {}),
      },
    })
    if (updated.count === 0) {
      return NextResponse.json({ error: 'No such conversation' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    return NextResponse.json({ error: 'Could not record it' }, { status: 500, headers: NO_STORE })
  }
}
