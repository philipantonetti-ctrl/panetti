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
 * Nothing in the UI calls this route any more: the token card that once
 * posted here is gone, and "Connect with Facebook" now runs the real login
 * dialog, the same as Google's. It stays reachable by hand for one release
 * anyway, because it is the only path to the account picker that needs no
 * Valid OAuth Redirect URI registered on the Facebook app — useful insurance
 * until that registration is confirmed working everywhere it matters. It is
 * also the only Meta credential this app can hold that never expires: a
 * login hands back a user token, and Facebook will not extend a user token
 * past roughly 60 days no matter how often it is renewed, while a system
 * user token can be generated with no expiry at all. Delete this route once
 * the live login is confirmed working — and re-argue that deletion on the
 * never-expiring point, not simply because the button is gone.
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

    // Optional on purpose. When the app keys happen to be saved we also learn
    // the token's expiry and scopes; without them the token still connects.
    // One field to fill is the whole point of this flow.
    const app = await db.adPlatformApp.findUnique({ where: { provider: 'meta' } })

    const { label, expiresAt } = await inspectMetaToken(
      app ? { clientId: app.clientId, clientSecret: decryptSecret(app.clientSecret) } : null,
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
