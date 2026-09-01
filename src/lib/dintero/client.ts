/**
 * Dintero's settlement API, read-only.
 *
 * One settlement = one payout to the bank. The list endpoint carries the
 * header (dates, totals per currency, attachments); the JSON report
 * attachment carries the bank reference and one line per order - the join
 * this integration exists for. Verified against the live docs 2026-09-01:
 * auth is client-credentials against the account, tokens live four hours.
 */

const BASE = 'https://api.dintero.com/v1'

/** A guard against a provider that pages forever. 10 x 100 weekly payouts is years. */
const MAX_PAGES = 10

const PAGE_SIZE = 100

/** Nothing here is worth hanging a sync run for. */
const TIMEOUT_MS = 20_000

/** Wording safe to store as lastError and show on the settings page. */
export class DinteroApiError extends Error {}

export type DinteroCredentials = {
  /** T or P plus eight digits; P is production. */
  accountId: string
  clientId: string
  clientSecret: string
}

export type DinteroAttachment = {
  id: string
  extension: string | null
  contentType: string | null
  createdBy: string | null
}

export type DinteroSettlement = {
  id: string
  provider: string | null
  /** Null while announced but not yet paid out. */
  settledAt: Date | null
  periodStart: Date | null
  periodEnd: Date | null
  currency: string
  /** Minor units: capture + refund - fee, the figure on the bank statement. */
  amount: number
  capture: number
  refund: number
  fee: number
  payoutDestinationId: string | null
  attachments: DinteroAttachment[]
}

export type DinteroReportLine = {
  transactionId: string
  /**
   * The transaction's merchant_reference. The Dintero WooCommerce plugin
   * fills it with a generated id (dwc...), not the order number.
   */
  reference: string
  /** merchant_reference_2 - where the plugin puts the real order number. */
  reference2: string | null
  amount: number
  capture: number
  refund: number
  fee: number
  transactionDate: Date | null
  paymentType: string | null
  cardBrand: string | null
}

export type DinteroReport = {
  /** The reference on the bank transfer. */
  reference: string | null
  lines: DinteroReportLine[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
const when = (v: unknown): Date | null => {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new DinteroApiError('Could not reach Dintero. Check the connection and try again.')
  }
  if (res.status === 401 || res.status === 403) {
    // Covers a mistyped secret, a deleted API client and a missing scope
    // alike - one sentence a person can act on, and never the secret itself.
    throw new DinteroApiError(
      'Dintero rejected the credentials. Check the Client ID and Client Secret in Dintero Backoffice and paste them again.',
    )
  }
  if (res.status === 429) {
    throw new DinteroApiError('Dintero is rate limiting us. It refreshes on the next scheduled sync.')
  }
  if (!res.ok) {
    // Dintero's error body names what it objected to. Without it, a 400 shown
    // to a person is just "400" - undebuggable from a toast, as proven live.
    let detail: string | null = null
    try {
      const body = (await res.json()) as { error?: { message?: unknown } }
      detail = str(body.error?.message)
    } catch {
      // An unreadable body leaves the status to speak for itself.
    }
    throw new DinteroApiError(
      detail
        ? `Dintero answered ${res.status}: ${detail.slice(0, 160)}`
        : `Dintero answered ${res.status}. Try again in a while.`,
    )
  }
  try {
    return await res.json()
  } catch {
    throw new DinteroApiError('Dintero answered with something that was not JSON. Try again in a while.')
  }
}

/**
 * Mints a four-hour access token for the account. Minted once per sync run
 * and once per connect - never cached across runs, so a rotated secret is
 * noticed on the next tick rather than four hours later.
 */
export async function getToken(creds: DinteroCredentials): Promise<string> {
  const body = (await request(`/accounts/${creds.accountId}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      audience: `${BASE}/accounts/${creds.accountId}`,
    }),
  })) as { access_token?: unknown }

  const token = str(body.access_token)
  if (!token) {
    throw new DinteroApiError('Dintero answered without an access token. Check the API client and try again.')
  }
  return token
}

function mapSettlement(row: {
  id?: unknown
  provider?: unknown
  settled_at?: unknown
  start_at?: unknown
  end_at?: unknown
  payout_destination_id?: unknown
  attachments?: unknown
  amounts?: unknown
}): DinteroSettlement | null {
  const id = str(row.id)
  if (!id) return null

  // One entry per currency; a webshop settles in exactly one, so the first
  // entry is the payout. A second currency would be a new fact about the
  // account, and the report download would surface it.
  const amounts = Array.isArray(row.amounts) ? row.amounts : []
  const a = (amounts[0] ?? {}) as Record<string, unknown>

  const attachments: DinteroAttachment[] = (Array.isArray(row.attachments) ? row.attachments : [])
    .map((raw) => {
      const at = raw as Record<string, unknown>
      const attachmentId = str(at.id)
      if (!attachmentId) return null
      return {
        id: attachmentId,
        extension: str(at.extension),
        contentType: str(at.content_type),
        createdBy: str(at.created_by),
      }
    })
    .filter((at): at is DinteroAttachment => at !== null)

  return {
    id,
    provider: str(row.provider),
    settledAt: when(row.settled_at),
    periodStart: when(row.start_at),
    periodEnd: when(row.end_at),
    currency: str(a.currency) ?? 'NOK',
    amount: int(a.amount),
    capture: int(a.capture),
    refund: int(a.refund),
    // The docs example writes the fee positive, the live API writes it
    // negative. Same money left either way - stored as a magnitude, and the
    // minus is a display decision.
    fee: Math.abs(int(a.fee)),
    payoutDestinationId: str(row.payout_destination_id),
    attachments,
  }
}

/**
 * Every settlement on the account, newest first as Dintero lists them.
 * Weekly payouts mean the full history is a few hundred rows, so the sync
 * simply reads it all each due run and upserts - no watermark to lose.
 *
 * Paging follows the envelope's last_evaluated_key, and the cursor is a PAIR:
 * starting_after_id must travel with starting_after_date (the key's
 * settled_at, or created_at while unpaid) or Dintero answers 400. A probe
 * fetches a single settlement - enough to prove the scope, no history walk.
 */
export async function listSettlements(
  creds: DinteroCredentials,
  token: string,
  opts: { payoutDestinationId?: string | null; probe?: boolean } = {},
): Promise<DinteroSettlement[]> {
  const rows: DinteroSettlement[] = []
  let after: { id: string; date: string } | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(opts.probe ? 1 : PAGE_SIZE) })
    if (opts.payoutDestinationId) params.set('payout_destination_id', opts.payoutDestinationId)
    if (after) {
      params.set('starting_after_id', after.id)
      params.set('starting_after_date', after.date)
    }

    const body = await request(`/accounts/${creds.accountId}/settlements?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // Accept a bare array as well as the documented {items, last_evaluated_key}
    // envelope - a bare array simply carries no cursor to follow.
    const rec = Array.isArray(body) ? null : (body as Record<string, unknown>)
    const list = rec === null ? (body as unknown[]) : (rec.items ?? rec.settlements ?? rec.data ?? [])
    if (!Array.isArray(list)) break

    const mapped = list
      .map((r) => mapSettlement(r as Record<string, unknown>))
      .filter((s): s is DinteroSettlement => s !== null)
    rows.push(...mapped)

    if (opts.probe || list.length === 0) break
    const key = (rec?.last_evaluated_key ?? null) as Record<string, unknown> | null
    const id = key ? str(key.id) : null
    const date = key ? (str(key.settled_at) ?? str(key.created_at)) : null
    if (!id || !date) break
    after = { id, date }
  }
  return rows
}

/** The normalized JSON report among a settlement's attachments, or null. */
export function pickJsonReport(attachments: DinteroAttachment[]): string | null {
  const hit = attachments.find(
    (a) => a.extension?.toLowerCase() === 'json' || a.contentType?.toLowerCase().includes('json'),
  )
  return hit?.id ?? null
}

/** The signed link carries its own authorization - our bearer stays home. */
async function fetchReportFile(url: string): Promise<unknown> {
  if (!url.startsWith('https://')) {
    throw new DinteroApiError('Dintero answered with a report link that did not look right. Try again in a while.')
  }
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new DinteroApiError('Could not reach Dintero. Check the connection and try again.')
  }
  if (!res.ok) {
    throw new DinteroApiError(`Dintero's report file answered ${res.status}. It retries on the next sync.`)
  }
  try {
    return await res.json()
  } catch {
    throw new DinteroApiError('Dintero answered with something that was not JSON. Try again in a while.')
  }
}

/**
 * Downloads and reads the normalized settlement report: the bank reference
 * and one line per order. Lines without a transaction id are dropped - they
 * cannot be keyed, and a row that upserts onto a different row every run is
 * worse than an honest gap.
 *
 * The attachment endpoint answers a link envelope - {url} pointing at the
 * file on storage - which is how Dintero's own Backoffice downloads it.
 * Proven the hard way: parsing that envelope as the report stored 68 real
 * payouts as "no orders". A direct file answer is accepted all the same.
 */
export async function downloadReport(
  creds: DinteroCredentials,
  token: string,
  settlementId: string,
  attachmentId: string,
): Promise<DinteroReport> {
  let body = (await request(
    `/accounts/${creds.accountId}/settlements/${settlementId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )) as { settlement_reference?: unknown; transactions?: unknown; url?: unknown }

  const fileUrl = str(body.url)
  if (fileUrl && !Array.isArray(body.transactions)) {
    body = (await fetchReportFile(fileUrl)) as { settlement_reference?: unknown; transactions?: unknown }
  }

  // One line per transaction. A capture event and its refund can arrive as
  // separate rows wearing the same transaction id - merged here, because two
  // stored rows would break the unique key and take the shop's sync down.
  const byId = new Map<string, DinteroReportLine>()
  for (const raw of Array.isArray(body.transactions) ? body.transactions : []) {
    const t = raw as Record<string, unknown>
    const transactionId = str(t.transaction_id)
    if (!transactionId) continue

    const row = {
      transactionId,
      reference: str(t.reference) ?? '',
      reference2: str(t.merchant_reference_2),
      amount: int(t.amount),
      capture: int(t.capture),
      refund: int(t.refund),
      fee: Math.abs(int(t.fee)),
      transactionDate: when(t.transaction_date),
      paymentType: str(t.payment_product_type),
      cardBrand: str(t.card_brand),
    }
    const seen = byId.get(transactionId)
    if (!seen) {
      byId.set(transactionId, row)
    } else {
      seen.amount += row.amount
      seen.capture += row.capture
      seen.refund += row.refund
      seen.fee += row.fee
      seen.reference ||= row.reference
      seen.reference2 ??= row.reference2
      seen.transactionDate ??= row.transactionDate
      seen.paymentType ??= row.paymentType
      seen.cardBrand ??= row.cardBrand
    }
  }

  const lines = [...byId.values()].map((l) => ({
    ...l,
    // The live rows carry no amount of their own; the header's identity
    // (amount = capture + refund - fee) holds per line too.
    amount: l.amount !== 0 ? l.amount : l.capture + l.refund - l.fee,
  }))

  return { reference: str(body.settlement_reference), lines }
}
