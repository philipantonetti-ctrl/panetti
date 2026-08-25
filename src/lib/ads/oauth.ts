import { AdApiError } from './types'

/**
 * The OAuth handshakes behind "Connect with Facebook / Google".
 *
 * The apps are the CLIENT'S own: their admin is the only person who ever logs
 * in, which is exactly the case both platforms allow without app review. Meta
 * calls that Standard Access, and a Business type app gets it automatically.
 *
 * There is no app-settings healing here any more. `ensureMetaApp` used to
 * prove the App ID, read the app's `app_domains` and write ours in - eighty
 * lines aimed at a field that was never the problem. The redirect URI was.
 */

export type PlatformApp = { clientId: string; clientSecret: string; developerToken?: string }

/** The stamp that ties an OAuth callback to the login this app started. */
export const STATE_COOKIE = 'ads_oauth_state'

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

const META = 'https://graph.facebook.com/v25.0'

/** Meta tokens usually say how long they live; when silent, plan for 60 days. */
const META_TOKEN_DAYS = 60

async function readJson<T>(res: Response): Promise<T & { error?: { message?: string } }> {
  return (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
}

/**
 * adwords reads the ad accounts. The other three are what the OpenID userinfo
 * endpoint needs, and `exchangeGoogleCode` below reads the connection's label
 * from it - with adwords alone Google answers 401 there and every Google login
 * lands as "Google Ads". The callback dedupes connections on that label, so a
 * constant one lets a second Google login overwrite the first one's refresh
 * token. Google's own client library sends this same set.
 */
const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/adwords',
].join(' ')

export function buildGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    // Offline + consent: without both, Google hands back no refresh token.
    access_type: 'offline',
    prompt: 'consent',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

/**
 * The dialog BeProfit's own login popup runs on, same endpoint and version.
 *
 * No `config_id`. Meta recommends one for Facebook Login for Business, but its
 * reference calls it optional and says `scope` "can still be included" - and a
 * configuration id would be one more value the client has to create and paste.
 * The redirect URI is the only thing this dialog needs that no API can set.
 */
export function buildMetaAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'ads_read,business_management',
  })
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`
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

export async function exchangeMetaCode(
  app: PlatformApp,
  redirectUri: string,
  code: string,
): Promise<{ token: string; expiresAt: Date; label: string }> {
  const short = await readJson<{ access_token?: string; expires_in?: number }>(
    await fetch(
      `${META}/oauth/access_token?${new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        client_secret: app.clientSecret,
        code,
      })}`,
    ),
  )
  if (!short.access_token)
    throw new AdApiError(short.error?.message ?? 'Facebook did not accept the login')

  // Trade the hours-lived token for the ~60-day one before storing anything.
  // A silent answer here is not a failure: the short token already works.
  const long = await readJson<{ access_token?: string; expires_in?: number }>(
    await fetch(
      `${META}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        fb_exchange_token: short.access_token,
      })}`,
    ),
  )
  const token = long.access_token ?? short.access_token
  // A silent long exchange must not borrow the 60-day estimate for a token
  // that is really the hours-lived short one: prefer what either exchange
  // actually reported before falling back to the guess.
  const seconds = long.expires_in ?? short.expires_in ?? META_TOKEN_DAYS * 24 * 60 * 60
  const expiresAt = new Date(Date.now() + seconds * 1000)

  const me = await readJson<{ name?: string }>(
    await fetch(`${META}/me?fields=name`, { headers: { Authorization: `Bearer ${token}` } }),
  )
  return { token, expiresAt, label: me.name ?? 'Facebook' }
}
