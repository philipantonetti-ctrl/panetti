import { AdApiError } from './types'

/**
 * The OAuth handshake behind "Connect with Google".
 *
 * The client's own OAuth client, published unverified: its admin is the only
 * person who ever logs in, which is the case Google allows without review.
 *
 * Meta is deliberately absent. Its dialog needs a login configuration living
 * inside developers.facebook.com that no API can create, so Meta connects by
 * a pasted system user token instead — see `./token.ts`.
 */

export type PlatformApp = { clientId: string; clientSecret: string; developerToken?: string }

/** The stamp that ties an OAuth callback to the login this app started. */
export const STATE_COOKIE = 'ads_oauth_state'

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

export function buildGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords',
    // Offline + consent: without both, Google hands back no refresh token.
    access_type: 'offline',
    prompt: 'consent',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export async function exchangeGoogleCode(
  app: PlatformApp,
  redirectUri: string,
  code: string,
): Promise<{ refreshToken: string; label: string }> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token)
    throw new AdApiError(body.error_description ?? body.error ?? 'Google did not accept the login')
  if (!body.refresh_token)
    throw new AdApiError(
      'Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.',
    )

  const who = (await (
    await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` },
    })
  )
    .json()
    .catch(() => ({}))) as { name?: string; email?: string }

  return { refreshToken: body.refresh_token, label: who.name ?? who.email ?? 'Google Ads' }
}
