import { AdApiError } from './types'

/**
 * Proving a pasted Meta system user token.
 *
 * Two questions, in order. `debug_token` asks what Facebook already knows
 * about the token — the app it belongs to, the permissions on it, when it
 * dies. `/me` asks the only question that truly matters: does it work.
 *
 * The first is a courtesy and never blocks: neither `expires_at: 0` meaning
 * "never" nor a SYSTEM_USER token type is documented in the current Graph
 * reference, so silence from Facebook proves nothing. The second is fatal,
 * and speaks Facebook's own words when it fails.
 *
 * Unreachable from the UI on purpose, same as its only caller,
 * `POST /api/ads/connections/meta` — see that route's header for why it is
 * still here and when it goes.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'

/** Named MetaApp, not PlatformApp: oauth.ts already exports that name for Google. */
export type MetaApp = { clientId: string; clientSecret: string }

/** The fields of `debug_token`'s data object that we act on. */
export type DebugTokenData = {
  is_valid?: boolean
  expires_at?: number
  scopes?: string[]
  app_id?: string
}

export type TokenVerdict =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; reason: string }

/** The app access token that lets us ask about somebody else's token. */
export async function metaAppToken(app: MetaApp): Promise<string> {
  const res = await fetch(
    `${GRAPH}/oauth/access_token?${new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: 'client_credentials',
    })}`,
  )
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    error?: { message?: string }
  }
  if (!body.access_token)
    throw new AdApiError(body.error?.message ?? 'Meta did not accept the App ID and secret')
  return body.access_token
}

/**
 * What `debug_token` said, turned into a decision. `null` — an unreadable or
 * failed answer — is silence, and silence blocks nothing.
 */
export function tokenVerdict(data: DebugTokenData | null, clientId: string): TokenVerdict {
  if (!data) return { ok: true, expiresAt: null }

  if (data.is_valid === false) {
    return { ok: false, reason: 'Facebook says this token is not valid. Generate it again.' }
  }
  if (data.app_id && data.app_id !== clientId) {
    return { ok: false, reason: 'This token belongs to a different Facebook app.' }
  }
  // An absent or empty scope list is silence too — only a populated list that
  // leaves ads_read out is evidence the permission was never ticked.
  if (data.scopes?.length && !data.scopes.includes('ads_read')) {
    return {
      ok: false,
      reason: 'This token has no ads_read permission. Generate it again and tick ads_read.',
    }
  }
  return { ok: true, expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null }
}

/**
 * Prove a pasted token and learn who it belongs to. Throws AdApiError.
 *
 * `app` is optional, and that is the point: demanding an App ID and secret
 * before a token is accepted puts one more wall in front of someone who only
 * wants to connect an ad account. Without them we skip `debug_token` and
 * lose the expiry date and the scope check — never the connection itself.
 */
export async function inspectMetaToken(
  app: MetaApp | null,
  token: string,
): Promise<{ label: string; expiresAt: Date | null }> {
  let data: DebugTokenData | null = null
  if (app) {
    try {
      const appToken = await metaAppToken(app)
      const res = await fetch(
        `${GRAPH}/debug_token?${new URLSearchParams({
          input_token: token,
          access_token: appToken,
        })}`,
      )
      if (res.ok) data = ((await res.json()) as { data?: DebugTokenData }).data ?? null
    } catch {
      // A courtesy check that cannot run tells us nothing. Fall through to /me.
    }
  }

  const verdict = tokenVerdict(data, app?.clientId ?? '')
  if (!verdict.ok) throw new AdApiError(verdict.reason)

  // The only question that proves anything.
  const meRes = await fetch(`${GRAPH}/me?fields=name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const me = (await meRes.json().catch(() => ({}))) as {
    name?: string
    error?: { message?: string }
  }
  if (!meRes.ok) {
    throw new AdApiError(me.error?.message ?? 'Facebook did not accept this token')
  }
  return { label: me.name ?? 'Facebook', expiresAt: verdict.expiresAt }
}
