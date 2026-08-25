import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError, assertAdmin } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { platformApp } from '@/lib/ads/platform-app'
import { STATE_COOKIE, exchangeGoogleCode, exchangeMetaCode } from '@/lib/ads/oauth'
import { AdApiError } from '@/lib/ads/types'

/**
 * The platform sends the admin back here with a one-time code. Trade it for
 * the durable token, remember who logged in, and open the account picker.
 * Logging in again with the same identity refreshes the stored token instead
 * of piling up connections - that IS the "reconnect" story.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/settings/ad-accounts${query}`, req.url))
    res.cookies.delete(STATE_COOKIE)
    return res
  }
  const fail = (message: string) => back(`?error=${encodeURIComponent(message)}`)

  try {
    assertAdmin(await currentUser())
    const { provider } = await params
    if (provider !== 'meta' && provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }

    const url = new URL(req.url)
    if (url.searchParams.get('error')) {
      return fail('The login was cancelled.')
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const stamped = (await cookies()).get(STATE_COOKIE)?.value
    if (!code || !state || stamped !== `${provider}:${state}`) {
      return fail('The login came back wrong. Try again.')
    }

    const app = await platformApp(provider)
    if (!app) {
      const platform = provider === 'meta' ? 'Facebook' : 'Google'
      return fail(`${platform} connect is not configured on the server.`)
    }
    const platformCredentials = { clientId: app.clientId, clientSecret: app.clientSecret }
    const redirectUri = `${url.origin}/api/ads/oauth/${provider}/callback`

    let secret: string
    let label: string
    // Google refresh tokens live as long as the client stays published; a
    // Meta user token is good for about 60 days and says so.
    let expiresAt: Date | null = null

    if (provider === 'meta') {
      const meta = await exchangeMetaCode(platformCredentials, redirectUri, code)
      secret = meta.token
      label = meta.label
      expiresAt = meta.expiresAt
    } else {
      const google = await exchangeGoogleCode(platformCredentials, redirectUri, code)
      secret = google.refreshToken
      label = google.label
    }

    const existing = await db.adConnection.findFirst({ where: { provider, label } })
    const connection = existing
      ? await db.adConnection.update({
          where: { id: existing.id },
          data: { secret: encryptSecret(secret), expiresAt },
        })
      : await db.adConnection.create({
          data: { provider, label, secret: encryptSecret(secret), expiresAt },
        })

    return back(`?picker=${connection.id}`)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    if (e instanceof AdApiError) return fail(e.message)
    console.error(e)
    return fail('Could not finish the login.')
  }
}
