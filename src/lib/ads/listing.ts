import { googleAccessToken } from './google'
import { AdApiError, type GoogleCredentials } from './types'

/**
 * "Which ad accounts can this login see?" — the checkbox list in the picker.
 */

export type ListedAccount = {
  externalId: string
  name: string
  currency: string
  /** Google: the manager (MCC) id the account was reached through. */
  loginCustomerId?: string
}

const META = 'https://graph.facebook.com/v25.0'
const GOOGLE = 'https://googleads.googleapis.com/v25'
const MAX_PAGES = 10

type MetaAccountsPage = {
  data?: { account_id?: string; name?: string; currency?: string }[]
  paging?: { next?: string }
  error?: { message?: string }
}

export async function listMetaAdAccounts(token: string): Promise<ListedAccount[]> {
  let url: string | undefined =
    `${META}/me/adaccounts?${new URLSearchParams({ fields: 'name,account_id,currency', limit: '100' })}`
  const out: ListedAccount[] = []

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const body = (await res.json().catch(() => ({}))) as MetaAccountsPage
    if (!res.ok) throw new AdApiError(body.error?.message ?? `Meta answered ${res.status}`)
    for (const row of body.data ?? []) {
      if (!row.account_id || !row.currency) continue
      out.push({ externalId: row.account_id, name: row.name ?? row.account_id, currency: row.currency })
    }
    url = body.paging?.next
  }
  return out
}

/** REST protobuf JSON is camelCase; tolerate snake_case anyway. */
type ClientResult = {
  customerClient?: {
    id?: string
    descriptiveName?: string
    descriptive_name?: string
    currencyCode?: string
    currency_code?: string
    manager?: boolean
  }
  customer_client?: {
    id?: string
    descriptiveName?: string
    descriptive_name?: string
    currencyCode?: string
    currency_code?: string
    manager?: boolean
  }
}

/** Flatten one accessible customer's client list into pickable leaf accounts. */
export function parseCustomerClients(results: ClientResult[], accessId: string): ListedAccount[] {
  const out: ListedAccount[] = []
  for (const r of results) {
    const c = r.customerClient ?? r.customer_client
    if (!c?.id || c.manager) continue // managers hold accounts, they are not one
    out.push({
      externalId: c.id,
      name: c.descriptiveName ?? c.descriptive_name ?? `Google Ads ${c.id}`,
      currency: c.currencyCode ?? c.currency_code ?? '',
      // Reached through a manager: syncs must say which one. Direct: no header.
      ...(c.id !== accessId ? { loginCustomerId: accessId } : {}),
    })
  }
  return out
}

function googleError(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body
  return (first as { error?: { message?: string } } | null)?.error?.message
}

export async function listGoogleAdAccounts(creds: GoogleCredentials): Promise<ListedAccount[]> {
  const token = await googleAccessToken(creds)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': creds.developerToken,
    'Content-Type': 'application/json',
  }

  const listRes = await fetch(`${GOOGLE}/customers:listAccessibleCustomers`, { headers })
  const listBody = (await listRes.json().catch(() => ({}))) as {
    resourceNames?: string[]
    error?: { message?: string }
  }
  if (!listRes.ok)
    throw new AdApiError(listBody.error?.message ?? `Google answered ${listRes.status}`)

  const accessIds = (listBody.resourceNames ?? []).map((r) => r.split('/')[1]).filter(Boolean)
  const byId = new Map<string, ListedAccount>()

  for (const accessId of accessIds) {
    const res = await fetch(`${GOOGLE}/customers/${accessId}/googleAds:searchStream`, {
      method: 'POST',
      headers: { ...headers, 'login-customer-id': accessId },
      body: JSON.stringify({
        query:
          'SELECT customer_client.id, customer_client.descriptive_name, ' +
          'customer_client.currency_code, customer_client.manager, customer_client.level ' +
          'FROM customer_client WHERE customer_client.level <= 1',
      }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      // One dead login among several must not empty the whole list.
      if (accessIds.length === 1) throw new AdApiError(googleError(body) ?? `Google answered ${res.status}`)
      continue
    }
    const chunks = Array.isArray(body) ? body : body ? [body] : []
    const results = chunks.flatMap((c) => (c as { results?: ClientResult[] }).results ?? [])
    for (const account of parseCustomerClients(results, accessId)) {
      if (!byId.has(account.externalId)) byId.set(account.externalId, account)
    }
  }
  return [...byId.values()]
}
