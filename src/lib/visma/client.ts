/**
 * Visma.net ERP, over HTTP. Read-only, and deliberately the same shape as
 * src/lib/bring/client.ts: a hard request ceiling and error bodies truncated so
 * a gateway's HTML page never reaches a log line.
 *
 * The host is the trap. The Developer Portal advertises
 * `https://api.finance.visma.net/erp/service`, which is the token's AUDIENCE —
 * every path under it 404s. Requests go to `https://integration.visma.net/API`.
 * Confirmed by probing unauthenticated: 404 means no route, 401 means the route
 * is there and only auth is missing.
 */

const TOKEN_URL = 'https://connect.visma.com/connect/token'
const BASE = 'https://integration.visma.net/API'
const SCOPE = 'vismanet_erp_service_api:read'

/** No single request gets longer than this, deadline or not. */
const REQUEST_TIMEOUT_MS = 60_000

/** Mint a new token this far before the old one dies, so a slow run cannot expire mid-flight. */
const RENEW_MARGIN_MS = 60_000

export type VismaCredentials = { clientId: string; clientSecret: string; tenantId: string }

export class VismaError extends Error {
  /**
   * The HTTP status, when there was one. Carried because 429 is not a failure
   * in the way 500 is: it means "ask again later", and a caller paging through
   * a large collection has to be able to stop cleanly rather than treat a
   * half-read collection as the whole truth.
   */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * The three values from the environment, or null when they are not all there.
 *
 * Null is not a failure. An unconfigured integration is skipped quietly, the
 * same way ensureWebhooks skips with no APP_URL — a deployment without Visma
 * credentials is a normal deployment.
 */
export function vismaCredentials(): VismaCredentials | null {
  const clientId = process.env.VISMA_CLIENT_ID?.trim()
  const clientSecret = process.env.VISMA_CLIENT_SECRET?.trim()
  const tenantId = process.env.VISMA_TENANT_ID?.trim()
  if (!clientId || !clientSecret || !tenantId) return null
  return { clientId, clientSecret, tenantId }
}

let cached: { token: string; expiresAt: number; key: string } | null = null

/** Tests only. Module state would otherwise leak a token between cases. */
export function resetVismaTokenCache(): void {
  cached = null
}

export async function vismaToken(
  creds: VismaCredentials,
  now: number = Date.now(),
  opts: VismaRequestOpts = {},
): Promise<string> {
  // Keyed by client and tenant so a credential change is never served a stale token.
  const key = `${creds.clientId}:${creds.tenantId}`
  if (cached && cached.key === key && cached.expiresAt - RENEW_MARGIN_MS > now) return cached.token

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: SCOPE,
      tenant_id: creds.tenantId,
    }),
    // Clamped like the GET below. A cold cache pays this mint FIRST, so a
    // clamp covering only the GET would leave the deadline honoured by the
    // second request and ignored by the one that always precedes it.
    signal: AbortSignal.timeout(vismaRequestBudgetMs(opts)),
  })

  if (!res.ok) {
    // Status only. The request body carried the secret, and an error that echoes
    // the request would put it in a log we do not control.
    throw new VismaError(`Visma refused the credentials (HTTP ${res.status})`)
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new VismaError('Visma returned no access token')

  cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000, key }
  return cached.token
}

export type VismaRequestOpts = { deadline?: number }

/**
 * What one request is allowed: the ceiling, or whatever is left of the caller's
 * run, whichever is smaller.
 *
 * Without this a deadline does not bound anything. The sync route gives the B2B
 * sales import until 265s of a 300s platform ceiling; a request starting at
 * 264.9s and taking its full 60 seconds finishes around 325s, overruns the
 * invocation, and takes the parcel poll and the delivery alert down with it —
 * exactly what the deadline exists to prevent. `bring/client.ts` clamps for
 * this reason and this is the same rule.
 *
 * BOTH requests a call can make are clamped: the token mint and the GET. A cold
 * cache pays the mint first, so covering only the GET would honour the deadline
 * on the second request and ignore it on the one that always comes before.
 * Each is clamped to what remains when IT starts, so the pair cannot together
 * outlive the budget either.
 *
 * A caller that passes no deadline — the other three Visma imports — is
 * unaffected and still gets the full ceiling.
 *
 * Never below 1ms: an expired budget still has to be a timeout a caller can
 * pass to AbortSignal, and it is the caller's loop that stops, not this.
 */
export function vismaRequestBudgetMs(opts: VismaRequestOpts, now = Date.now()): number {
  const left = opts.deadline === undefined ? REQUEST_TIMEOUT_MS : opts.deadline - now
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, left))
}

export async function vismaGet<T>(
  creds: VismaCredentials,
  path: string,
  opts: VismaRequestOpts = {},
): Promise<T> {
  // The caller's budget covers the whole call, mint included. Each request is
  // clamped to what is left when IT starts, so a slow mint leaves the GET the
  // 1ms floor rather than a fresh minute of its own.
  const token = await vismaToken(creds, Date.now(), opts)
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(vismaRequestBudgetMs(opts)),
  })

  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new VismaError(`Visma responded ${res.status} for ${path}: ${text}`, res.status)
  }

  return (await res.json()) as T
}
