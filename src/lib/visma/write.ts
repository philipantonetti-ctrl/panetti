/**
 * Writing to Visma.net ERP - the TEST company only, by construction.
 *
 * Our app is connected to two companies (Developer Portal, 2026-10-15):
 * the real books, read only, and "Test LEDENDE TEKNOLOGI AS", read + create.
 * Visma itself refuses a write to the real books because that company never
 * accepted the create scope; this file refuses it a second time, before any
 * request leaves, so a mistake in our own code cannot reach the accountant's
 * ledger either. Moving to the real company is a deliberate code change after
 * the bookkeeper signs off, never a setting.
 *
 * The tenant is a constant rather than an env var: only Philip can set Vercel
 * variables, and a tenant id is an address, not a secret.
 */

import {
  vismaCredentials,
  vismaPath,
  vismaRequestBudgetMs,
  vismaToken,
  VismaError,
  VISMA_BASE,
  type VismaCredentials,
  type VismaRequestOpts,
} from './client'

export const REAL_TENANT_ID = '83949a19-af32-11ec-b60b-0638767d04b5'
export const TEST_TENANT_ID = '08058ec7-a375-11ec-b60b-0638767d04b5'

/** Exactly what the test company accepted. Asking for more fails the whole token request. */
export const WRITE_SCOPE = 'vismanet_erp_service_api:read vismanet_erp_service_api:create'

/** The app's client credentials, pointed at the test company whatever VISMA_TENANT_ID says. */
export function writeCredentials(): VismaCredentials | null {
  const base = vismaCredentials()
  if (!base) return null
  return { clientId: base.clientId, clientSecret: base.clientSecret, tenantId: TEST_TENANT_ID }
}

export function assertWritableTenant(tenantId: string): void {
  const t = tenantId.trim().toLowerCase()
  if (t === REAL_TENANT_ID) throw new VismaError('Refusing to write to the real Visma company')
  if (t !== TEST_TENANT_ID) throw new VismaError(`Refusing to write to an unknown Visma company (${tenantId})`)
}

/** The new document's number: the last segment of the 201's Location header. */
export function numberFromLocation(location: string | null): string | null {
  if (!location) return null
  const last = location.split('?')[0].replace(/\/+$/, '').split('/').pop()
  return last ? decodeURIComponent(last) : null
}

export type VismaCreated = { status: number; number: string | null }

export async function vismaPost(
  creds: VismaCredentials,
  path: string,
  body: unknown,
  opts: VismaRequestOpts = {},
): Promise<VismaCreated> {
  assertWritableTenant(creds.tenantId)
  const token = await vismaToken(creds, Date.now(), opts, WRITE_SCOPE)
  const res = await fetch(`${VISMA_BASE}/${vismaPath(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(vismaRequestBudgetMs(opts)),
  })
  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new VismaError(`Visma responded ${res.status} for POST ${path}: ${text}`, res.status)
  }
  return { status: res.status, number: numberFromLocation(res.headers.get('location')) }
}
