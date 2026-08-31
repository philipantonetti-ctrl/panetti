import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * A face, set by hand.
 *
 * Gorgias keeps uploaded profile photos behind its own app - the bucket
 * refuses the open internet AND server-side API auth (both measured
 * 2026-08-31) - so the sync can only mirror the rare picture on their public
 * assets host. For everyone else the admin picks the photo here, into the
 * same column the sync fills, and the page cannot tell the two apart.
 */
const Body = z.object({
  agent: z.string().trim().min(1),
  /**
   * A data URI, at most ~300KB of pixels. An avatar renders at 28px; anything
   * bigger is weight every load of the page would carry.
   */
  image: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Choose a PNG, JPEG or WebP image')
    .max(400_000, 'That image is too large - pick one under about 300KB'),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const raw = await req.json().catch(() => null)
    if (raw === null) return NextResponse.json({ error: 'Invalid details' }, { status: 400, headers: NO_STORE })
    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400, headers: NO_STORE },
      )
    }
    const { agent, image } = parsed.data

    // Every helpdesk row wearing this name gets the face - names are how the
    // tickets identify people, so names are the join here too.
    const updated = await db.supportAgent.updateMany({
      where: { name: agent },
      data: { avatarData: image },
    })
    if (updated.count === 0) {
      // A person the helpdesk list does not carry yet still gets their photo:
      // a manual row, keyed by the name itself.
      await db.supportAgent.upsert({
        where: { source_externalId: { source: 'manual', externalId: agent } },
        create: { source: 'manual', externalId: agent, name: agent, avatarData: image },
        update: { avatarData: image },
      })
    }

    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403, headers: NO_STORE })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the photo' }, { status: 500, headers: NO_STORE })
  }
}
