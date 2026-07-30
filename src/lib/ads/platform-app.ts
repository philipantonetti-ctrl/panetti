import { db } from '@/lib/db'
import { decryptSecret } from '@/lib/secrets'

/**
 * Where the Meta and Google app credentials come from.
 *
 * The environment first, the AdPlatformApp row second. That order is the whole
 * point: these used to be a form the client filled in, which made him register
 * a Facebook app and apply for a Google developer token before he could press
 * a button. They are server configuration, and BeProfit — the tool he compared
 * us to — has always treated them that way.
 *
 * The row survives as a fallback rather than being dropped, so a mistyped
 * variable name on Vercel cannot take the live site dark.
 */

export type PlatformCredentials = {
  clientId: string
  clientSecret: string
  developerToken?: string
}

type Provider = 'meta' | 'google'

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

export async function platformApp(provider: Provider): Promise<PlatformCredentials | null> {
  const keys = ENV[provider]
  const clientId = env(keys.id)
  const clientSecret = env(keys.secret)
  if (clientId && clientSecret) {
    const developerToken = env(keys.developerToken)
    return { clientId, clientSecret, ...(developerToken ? { developerToken } : {}) }
  }

  const row = await db.adPlatformApp.findUnique({ where: { provider } })
  if (!row) return null
  // decryptSecret returns a value without the enc:v1: prefix unchanged, so one
  // path serves an encrypted row and a plaintext variable alike.
  return {
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecret),
    ...(row.developerToken ? { developerToken: decryptSecret(row.developerToken) } : {}),
  }
}

/**
 * What the ad-accounts page is allowed to know: whether a button will work.
 * Google needs the developer token as well, because every call after the login
 * carries it. Meta needs only the app it logs into.
 */
export async function configuredProviders(): Promise<{ meta: boolean; google: boolean }> {
  const [meta, google] = await Promise.all([platformApp('meta'), platformApp('google')])
  return {
    meta: Boolean(meta),
    google: Boolean(google?.developerToken),
  }
}
