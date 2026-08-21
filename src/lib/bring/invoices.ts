import { requestBudgetMs, type BringCredentials, type BringFilter } from './client'
import { mapInvoices, type BringInvoice } from './invoice-map'

/**
 * Bring's money endpoints, over HTTP.
 *
 * A different host from tracking — www.mybring.com rather than api.bring.com —
 * and the same three headers. Shaped like src/lib/bring/client.ts on purpose:
 * a budget clamped to whatever is left of the caller's deadline, and error
 * bodies truncated so a gateway's HTML page never reaches a log line.
 */
const BASE = 'https://www.mybring.com'
const REPORT = 'MASTER-SPECIFIED_INVOICE'

function headers(creds: BringCredentials, accept: string): Record<string, string> {
  return {
    'X-Mybring-API-Uid': creds.uid,
    'X-Mybring-API-Key': creds.key,
    'X-Bring-Client-URL': creds.clientUrl,
    Accept: accept,
  }
}

async function get(
  creds: BringCredentials,
  url: string,
  opts: BringFilter,
  accept = 'application/json',
): Promise<Response> {
  const res = await fetch(url, {
    headers: headers(creds, accept),
    signal: AbortSignal.timeout(requestBudgetMs(opts)),
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    throw new Error(`Bring responded ${res.status}: ${text}`)
  }
  return res
}

/**
 * Every customer number this login may act for.
 *
 * Through the Reports API, NOT Customer Info. Measured 2026-08-20: Customer
 * Info returned three numbers and Reports returned four — the Swedish entity
 * appears only here. Enumerating through the other one loses a whole company's
 * freight with nothing on screen to say so.
 */
export async function listCustomerNumbers(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<string[]> {
  const res = await get(creds, `${BASE}/reports/api/generate`, opts)
  const body = (await res.json()) as { customer?: ({ id?: unknown } | null)[] }
  return (body.customer ?? [])
    .map((c) => (c != null && typeof c.id === 'string' ? c.id : ''))
    .filter((id) => id !== '')
}

export async function listInvoices(
  creds: BringCredentials,
  customerNumber: string,
  opts: BringFilter = {},
): Promise<BringInvoice[]> {
  const res = await get(creds, `${BASE}/invoicearchive/api/invoices/${customerNumber}.json`, opts)
  return mapInvoices(await res.json())
}

/** Returns the statusUrl to poll. The report takes an invoice number and nothing else. */
export async function generateSpecReport(
  creds: BringCredentials,
  customerNumber: string,
  invoiceNumber: string,
  opts: BringFilter = {},
): Promise<string> {
  const url =
    `${BASE}/reports/api/generate/${customerNumber}/${REPORT}/` +
    `?invoiceNumber=${encodeURIComponent(invoiceNumber)}`
  const res = await get(creds, url, opts)
  const body = (await res.json()) as { statusUrl?: unknown }
  if (typeof body.statusUrl !== 'string') throw new Error('Bring returned no statusUrl')
  return body.statusUrl
}

/**
 * `done` means stop polling, not success. FAILED is done with nothing to
 * download; a row left REQUESTED forever is the silent freeze this avoids.
 */
export async function reportStatus(
  creds: BringCredentials,
  statusUrl: string,
  opts: BringFilter = {},
): Promise<{ done: boolean; xmlUrl: string | null }> {
  const res = await get(creds, statusUrl, opts)
  const body = (await res.json()) as { status?: unknown; xmlUrl?: unknown }
  const xmlUrl = typeof body.xmlUrl === 'string' ? body.xmlUrl : null
  if (body.status === 'DONE') return { done: true, xmlUrl }
  if (body.status === 'FAILED') return { done: true, xmlUrl: null }
  return { done: false, xmlUrl: null }
}

export async function downloadReport(
  creds: BringCredentials,
  xmlUrl: string,
  opts: BringFilter = {},
): Promise<string> {
  const res = await get(creds, xmlUrl, opts, 'application/xml')
  return res.text()
}
