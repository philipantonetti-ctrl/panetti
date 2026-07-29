import type { AdCredentials } from './types'

/**
 * Shared shapes for the ad-account routes: what the UI may see, and how pasted
 * identifiers and credentials are cleaned up before they touch a platform.
 */

export type PublicAdAccount = {
  id: string
  provider: string
  externalId: string
  name: string
  currency: string
  shopId: string
  shopName: string
  connectionLabel: string | null
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
  createdAt: Date
}

/** Whatever the UI may see. Credentials never leave the server. */
export function toPublic(account: {
  id: string
  provider: string
  externalId: string
  name: string
  currency: string
  shopId: string
  active: boolean
  lastSyncAt: Date | null
  lastError: string | null
  createdAt: Date
  shop?: { name: string }
  connection?: { label: string } | null
}): PublicAdAccount {
  return {
    id: account.id,
    provider: account.provider,
    externalId: account.externalId,
    name: account.name,
    currency: account.currency,
    shopId: account.shopId,
    shopName: account.shop?.name ?? '',
    connectionLabel: account.connection?.label ?? null,
    active: account.active,
    lastSyncAt: account.lastSyncAt,
    lastError: account.lastError,
    createdAt: account.createdAt,
  }
}

/** Meta ids arrive as "act_123", Google ids as "123-456-7890"; keep the digits. */
export function normalizeExternalId(raw: string): string {
  return raw.replace(/^act_/, '').replace(/[\s-]/g, '')
}

export type CredentialFields = {
  provider: 'meta' | 'google'
  accessToken?: string
  developerToken?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  loginCustomerId?: string
}

/** Build provider credentials, or return the words for what is missing. */
export function credentialsFrom(data: CredentialFields): AdCredentials | string {
  if (data.provider === 'meta') {
    if (!data.accessToken) return 'Paste the system user access token'
    return { accessToken: data.accessToken }
  }
  if (!data.developerToken) return 'Paste the developer token'
  if (!data.clientId || !data.clientSecret) return 'Paste the OAuth client ID and secret'
  if (!data.refreshToken) return 'Paste the refresh token'
  return {
    developerToken: data.developerToken,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    refreshToken: data.refreshToken,
    ...(data.loginCustomerId ? { loginCustomerId: normalizeExternalId(data.loginCustomerId) } : {}),
  }
}
