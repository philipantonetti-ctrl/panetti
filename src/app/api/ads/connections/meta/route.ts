import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@/lib/auth/current-user'
import { assertAdmin, AuthError } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secrets'
import { inspectMetaToken } from '@/lib/ads/token'
import { AdApiError } from '@/lib/ads/types'

/**
 * "I pasted a system user token." Prove it, remember who it belongs to, and
 * hand back a connection the account picker can open.
 *
 * This replaces the Facebook login dialog, which could never work against a
 * Business type app without a login configuration we cannot create for him.
 * A token needs no login product, no redirect URI and no app domains.
 */

const Body = z.object({
  token: z.string().trim().min(1, 'Paste the system user access token'),
})

export async function POST(req: Request) {
  try {
    assertAdmin(await currentUser())

    const parsed = Body.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid details' },
        { status: 400 },
      )
    }

    const app = await db.adPlatformApp.findUnique({ where: { provider: 'meta' } })
    if (!app) {
      return NextResponse.json(
        { error: 'Fill in the Meta app ID and secret below first.' },
        { status: 400 },
      )
    }

    const { label, expiresAt } = await inspectMetaToken(
      { clientId: app.clientId, clientSecret: decryptSecret(app.clientSecret) },
      parsed.data.token,
    )

    // Same de-dupe rule the Google callback uses: one row per person, so
    // pasting a fresh token refreshes rather than piling up connections.
    const existing = await db.adConnection.findFirst({ where: { provider: 'meta', label } })
    const connection = existing
      ? await db.adConnection.update({
          where: { id: existing.id },
          data: { secret: encryptSecret(parsed.data.token), expiresAt },
        })
      : await db.adConnection.create({
          data: { provider: 'meta', label, secret: encryptSecret(parsed.data.token), expiresAt },
        })

    return NextResponse.json({ connectionId: connection.id, label, expiresAt })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error(e)
    return NextResponse.json({ error: 'Could not save the token' }, { status: 500 })
  }
}
