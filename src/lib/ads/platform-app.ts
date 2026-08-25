import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'

/**
 * Where the Meta and Google app credentials come from.
 *
 * The environment first, the AdPlatformApp row second. That order is the whole
 * point: these used to be a form the client filled in, which made him register
 * a Facebook app and apply for a Google developer token before he could press
 * a button. They are server configuration, and BeProfit - the tool he compared
 * us to - has always treated them that way.
 *
 * The row survives as a fallback rather than being dropped, so a mistyped
 * variable name on Vercel cannot take the live site dark. Google's developer
 * token can fall back on its own, separately from its client ID and secret:
 * the token belongs to the manager account, not the OAuth client, so a typo
 * in just that variable name must not drag a correct id/secret pair down
 * with it.
 *
 * Every use of the row is logged. A silent fallback is what makes it
 * dangerous - it keeps the site working right up until someone assumes an
 * environment variable is in effect that never took. `console.warn` fires
 * only when the row answers *and* at least one of that provider's variables
 * was set in the environment; the ordinary today-nothing-is-set state stays
 * quiet.
 */

export type PlatformCredentials = {
  clientId: string
  clientSecret: string
  developerToken?: string
}

type Provider = 'meta' | 'google'

/** Same shape as `PlatformCredentials`, but a field may still be `enc:v1:`
 * ciphertext. Named apart so a reader never mistakes one for plaintext. */
type RawCredentials = PlatformCredentials

const ENV: Record<Provider, { id: string; secret: string; developerToken?: string }> = {
  meta: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  google: {
    id: 'GOOGLE_ADS_CLIENT_ID',
    secret: 'GOOGLE_ADS_CLIENT_SECRET',
    developerToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
  },
}

/** Vercel hands back empty strings for variables that were never filled in. */
function env(name: string | undefined): string | undefined {
  if (!name) return undefined
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

/**
 * A row that answers while an environment variable for that provider was
 * set is never intentional - it is a typo, or a rollout half finished.
 * `seenEnvKeys` is whichever of that provider's variables had a value,
 * regardless of whether the fallback below needed all of them. Nothing is
 * logged when the list is empty: that is the ordinary state before the
 * operator has set any of the five, and warning on it would train people to
 * ignore this message.
 */
function warnFallback(provider: Provider, seenEnvKeys: string[], using: string): void {
  if (seenEnvKeys.length === 0) return
  const plural = seenEnvKeys.length > 1
  console.warn(
    `[platform-app] ${provider}: ${using}, even though ${seenEnvKeys.join(', ')} ` +
      `${plural ? 'are' : 'is'} set in the environment. That combination is usually a typo ` +
      `- check the name${plural ? 's' : ''}.`,
  )
}

/**
 * Resolves which source answers a provider, without decrypting anything.
 * `platformApp` layers `decryptSecret` on top for callers that need usable
 * credentials. `configuredProviders` reads this directly instead of going
 * through `platformApp`, because whether a button should work is a presence
 * question, not a plaintext one - asking it must never risk a throw from an
 * undecryptable secret.
 */
async function resolveRaw(provider: Provider): Promise<RawCredentials | null> {
  const keys = ENV[provider]
  const clientId = env(keys.id)
  const clientSecret = env(keys.secret)
  const developerToken = env(keys.developerToken)

  const missingDeveloperToken = keys.developerToken !== undefined && !developerToken
  if (clientId && clientSecret && !missingDeveloperToken) {
    return { clientId, clientSecret, developerToken }
  }

  // Something is missing: the id/secret pair, or - Google only - just the
  // developer token while id and secret are both fine. Whichever of this
  // provider's variables WERE set get named in the fallback warning below,
  // so a typo in one of them cannot look identical to nobody having
  // configured anything.
  const seen = [
    clientId ? keys.id : null,
    clientSecret ? keys.secret : null,
    keys.developerToken && developerToken ? keys.developerToken : null,
  ].filter((name): name is string => name !== null)

  const row = await db.adPlatformApp.findUnique({ where: { provider } })

  if (!clientId || !clientSecret) {
    // Neither source alone is complete for the id/secret pair: the row
    // answers wholesale, the same as before this variable existed.
    if (!row) return null
    warnFallback(provider, seen, 'using the database row for its client ID and secret')
    return {
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      developerToken: row.developerToken ?? undefined,
    }
  }

  // clientId and clientSecret both came from the environment here. Only
  // Google's developer token can still be missing - Meta has no
  // developerToken key, so `missingDeveloperToken` is always false for it,
  // and this branch is a no-op for Meta. Pulling just the token from the row
  // while id/secret stay in the environment is safe to mix: the token
  // belongs to the manager account, not to the OAuth client the id/secret
  // identify.
  if (row?.developerToken) {
    warnFallback(provider, seen, "using the database row's developer token")
  }
  return { clientId, clientSecret, developerToken: developerToken ?? row?.developerToken ?? undefined }
}

export async function platformApp(provider: Provider): Promise<PlatformCredentials | null> {
  const raw = await resolveRaw(provider)
  if (!raw) return null

  // One decrypt for both sources, deliberately. decryptSecret returns a value
  // without the enc:v1: prefix unchanged, so the documented path - pasting
  // the plaintext value straight from Facebook's or Google's own dashboard -
  // passes through untouched. A value copied straight out of the database is
  // enc:v1: ciphertext and still decrypts here too, kept for compatibility,
  // though it ties the deployment to whichever AUTH_SECRET encrypted it (see
  // .env.example). Branching on which shape arrived would turn that
  // compatibility path into a trap.
  return {
    clientId: raw.clientId,
    clientSecret: decryptSecret(raw.clientSecret),
    ...(raw.developerToken ? { developerToken: decryptSecret(raw.developerToken) } : {}),
  }
}

/**
 * What the ad-accounts page is allowed to know: whether a button will work.
 * Google needs the developer token as well, because every call after the
 * login carries it. Meta needs only the app it logs into.
 *
 * Presence only, never plaintext. This calls `resolveRaw` directly rather
 * than `platformApp`, so an undecryptable secret - the wrong AUTH_SECRET, a
 * malformed blob, an unknown `enc:` version - cannot take the settings page
 * down over a question that never needed the plaintext to answer.
 */
export async function configuredProviders(): Promise<{ meta: boolean; google: boolean }> {
  const [meta, google] = await Promise.all([resolveRaw('meta'), resolveRaw('google')])
  return {
    meta: Boolean(meta),
    google: Boolean(google?.developerToken),
  }
}
