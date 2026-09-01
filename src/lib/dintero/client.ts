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
  /** What Dintero calls the order - the webshop's own order number. */
  reference: string
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
    throw new DinteroApiError(`Dintero answered ${res.status}. Try again in a while.`)
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
    fee: int(a.fee),
    payoutDestinationId: str(row.payout_destination_id),
    attachments,
  }
}

/**
 * Every settlement on the account, newest first as Dintero lists them.
 * Weekly payouts mean the full history is a few hundred rows, so the sync
 * simply reads it all each due run and upserts - no watermark to lose.
 */
export async function listSettlements(
  creds: DinteroCredentials,
  token: string,
  opts: { payoutDestinationId?: string | null } = {},
): Promise<DinteroSettlement[]> {
  const rows: DinteroSettlement[] = []
  let after: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (opts.payoutDestinationId) params.set('payout_destination_id', opts.payoutDestinationId)
    if (after) params.set('starting_after_id', after)

    const body = await request(`/accounts/${creds.accountId}/settlements?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // The docs specify the item, not the envelope - accept both a bare array
    // and the obvious wrappers rather than break on a packaging choice.
    const list = Array.isArray(body)
      ? body
      : ((body as Record<string, unknown>).settlements ??
        (body as Record<string, unknown>).items ??
        (body as Record<string, unknown>).data ??
        [])
    if (!Array.isArray(list)) break

    const mapped = list
      .map((r) => mapSettlement(r as Record<string, unknown>))
      .filter((s): s is DinteroSettlement => s !== null)
    rows.push(...mapped)

    if (list.length < PAGE_SIZE || mapped.length === 0) break
    after = mapped[mapped.length - 1].id
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

/**
 * Downloads and reads the normalized settlement report: the bank reference
 * and one line per order. Lines without a transaction id are dropped - they
 * cannot be keyed, and a row that upserts onto a different row every run is
 * worse than an honest gap.
 */
export async function downloadReport(
  creds: DinteroCredentials,
  token: string,
  settlementId: string,
  attachmentId: string,
): Promise<DinteroReport> {
  const body = (await request(
    `/accounts/${creds.accountId}/settlements/${settlementId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )) as { settlement_reference?: unknown; transactions?: unknown }

  const lines: DinteroReportLine[] = (Array.isArray(body.transactions) ? body.transactions : [])
    .map((raw) => {
      const t = raw as Record<string, unknown>
      const transactionId = str(t.transaction_id)
      if (!transactionId) return null
      return {
        transactionId,
        reference: str(t.reference) ?? '',
        amount: int(t.amount),
        capture: int(t.capture),
        refund: int(t.refund),
        fee: int(t.fee),
        transactionDate: when(t.transaction_date),
        paymentType: str(t.payment_product_type),
        cardBrand: str(t.card_brand),
      }
    })
    .filter((l): l is DinteroReportLine => l !== null)

  return { reference: str(body.settlement_reference), lines }
}
