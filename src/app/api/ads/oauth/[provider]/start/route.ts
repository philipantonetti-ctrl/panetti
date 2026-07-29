import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { currentUser } from '@/lib/auth/current-user'
import { AuthError, assertAdmin } from '@/lib/auth/guard'
import { db } from '@/lib/db'
import { STATE_COOKIE, buildGoogleAuthUrl } from '@/lib/ads/oauth'

/**
 * Step one of "Connect with Google": stamp a state cookie and send the admin
 * to Google's login dialog. The callback checks the stamp so a foreign
 * redirect cannot plant a connection.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const back = (path: string) => NextResponse.redirect(new URL(path, req.url))
  try {
    assertAdmin(await currentUser())
    const { provider } = await params
    // Google only. Meta connects by pasted system user token instead: its
    // login dialog needs a configuration inside developers.facebook.com that
    // no API can create, so this door never opened for it.
    if (provider !== 'google') {
      return NextResponse.json({ error: 'No such platform' }, { status: 404 })
    }

    const app = await db.adPlatformApp.findUnique({ where: { provider } })
    if (!app) {
      return back(
        `/settings/ad-accounts?error=${encodeURIComponent('Fill in the platform setup below first.')}`,
      )
    }

    const state = randomBytes(16).toString('hex')
    const origin = new URL(req.url).origin
    const redirectUri = `${origin}/api/ads/oauth/${provider}/callback`
    const url = buildGoogleAuthUrl(app.clientId, redirectUri, state)

    const res = NextResponse.redirect(url)
    res.cookies.set(STATE_COOKIE, `${provider}:${state}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https'),
      path: '/',
      maxAge: 600,
    })
    return res
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 403 })
    console.error(e)
    return back(`/settings/ad-accounts?error=${encodeURIComponent('Could not start the login.')}`)
  }
}
