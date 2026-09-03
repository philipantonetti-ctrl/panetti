/**
 * Read-only questions for Visma, asked from inside the scheduled sync.
 *
 * The posting design (docs/superpowers/specs/2026-09-03-visma-payout-posting-
 * design.md) needs seven facts only the live company can answer: which cash
 * accounts and payment methods exist, which field on a webshop invoice carries
 * the order number, whether refunds already have credit notes, and how
 * settlements are booked today. The credentials that can ask live only in the
 * production environment, so the questions are asked THERE, by the cron that
 * already holds them, and the answers are kept in `DiagnosticSnapshot` for a
 * person to read.
 *
 * Every step is a GET. Nothing here can write to Visma: the client has no
 * method for it. Each answer is stored the moment it lands, so a run cut short
 * by the rate limit keeps what it got and the next run continues from there.
 * A step that Visma refuses with anything but a 429 stores the refusal under
 * its own key, so a wrong query is read and corrected rather than retried
 * every quarter of an hour forever. Bump VISMA_PROBE_VERSION to ask again.
 */

import type { Prisma } from '@prisma/client'
import { db } from '../db'
import {
  vismaCredentials,
  vismaGet,
  vismaScopeCheck,
  VismaError,
  WRITE_SCOPES,
  type VismaScopeAnswer,
} from './client'
import { unwrap } from './purchase-orders'
import { isWebshopAccount } from './receivables'

export const VISMA_PROBE_VERSION = 1

export const probeKey = (step: string): string => `visma-probe:v${VISMA_PROBE_VERSION}:${step}`

/** The rate limit holds for minutes once hit, so a run asks little and stops early. */
const DEFAULT_MAX_CALLS = 4
const DEFAULT_PAUSE_MS = 2_000
/** A step is not started when less than this is left of the caller's budget. */
const STEP_MARGIN_MS = 25_000

type Row = Record<string, unknown>
type Get = (path: string) => Promise<unknown>
type Ctx = {
  get: Get
  stored: (step: string) => Promise<unknown>
  /** One token request with the given scopes, answered without the token. */
  scopeCheck: (scope: string) => Promise<VismaScopeAnswer>
}

export type ProbeStep = {
  name: string
  /** How many GETs the step makes. A run never starts a step it cannot afford. */
  calls: number
  run: (ctx: Ctx) => Promise<unknown>
  /**
   * True when a stored answer is not final and the question should be asked
   * again next run. Only the write-scope step uses it: a refusal there means
   * the company has not accepted the scopes YET, and the moment it does is
   * something the cron should notice on its own.
   */
  again?: (stored: unknown) => boolean
}

export type VismaProbeResult = {
  configured: boolean
  ran: string[]
  pending: string[]
  calls: number
  /** True when the rate limit or the deadline stopped the run early. */
  partial: boolean
  error: string | null
}

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()
const num = (v: unknown): number => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}
const day = (v: unknown): string => str(v).slice(0, 10)
const enc = encodeURIComponent

/** A few named fields of a row, unwrapped, dropping anything absent. */
function pick(row: unknown, keys: string[]): Row {
  const r = (row ?? {}) as Row
  const out: Row = {}
  for (const k of keys) {
    const v = unwrap<unknown>(r[k])
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

/** A row without its bulkiest nested blocks, for shapes not known in advance. */
function without(row: unknown, keys: string[]): Row {
  const r = { ...((row ?? {}) as Row) }
  for (const k of keys) delete r[k]
  return r
}

export type WebshopCustomer = {
  number: string
  name: string
  documents: number
  invoices: number
  creditNotes: number
  currencies: Record<string, number>
  /** Minor units, per currency. */
  balance: Record<string, number>
  oldest: string
  newest: string
  sampleRefs: string[]
}

/**
 * The open customer ledger, grouped by webshop house account. The `- Webkunde`
 * accounts are the ones a payout settles; everything else is counted so the
 * page size can be judged (a full page of 1000 is a sample, not a census).
 */
export function summariseWebshopCustomers(docs: unknown): {
  read: number
  others: number
  webshop: WebshopCustomer[]
} {
  const list = rows(docs)
  const byNumber = new Map<string, WebshopCustomer>()
  let others = 0

  for (const d of list) {
    const customer = (d.customer ?? {}) as Row
    const name = str(customer.name)
    if (!isWebshopAccount(name)) {
      others++
      continue
    }
    const number = str(customer.number)
    const c = byNumber.get(number) ?? {
      number,
      name,
      documents: 0,
      invoices: 0,
      creditNotes: 0,
      currencies: {},
      balance: {},
      oldest: '',
      newest: '',
      sampleRefs: [],
    }
    const currency = str(d.currencyId)
    const type = str(d.documentType)
    const date = day(d.documentDate)
    c.documents++
    if (/invoice/i.test(type)) c.invoices++
    if (/credit/i.test(type)) c.creditNotes++
    c.currencies[currency] = (c.currencies[currency] ?? 0) + 1
    c.balance[currency] = (c.balance[currency] ?? 0) + Math.round(num(d.balanceInCurrency) * 100)
    if (date && (!c.oldest || date < c.oldest)) c.oldest = date
    if (date && (!c.newest || date > c.newest)) c.newest = date
    if (c.sampleRefs.length < 3) c.sampleRefs.push(str(d.referenceNumber))
    byNumber.set(number, c)
  }

  return { read: list.length, others, webshop: [...byNumber.values()] }
}

/** The house account for one shop: by name when the name says, else by currency. */
export function pickWebshopCustomer<T extends { name: string; currencies: Record<string, number> }>(
  customers: T[],
  brand: RegExp,
  country: RegExp,
  currency: string,
): T | null {
  return (
    customers.find((c) => brand.test(c.name) && country.test(c.name)) ??
    customers.find((c) => (c.currencies[currency] ?? 0) > 0) ??
    null
  )
}

const HEADER_KEYS = [
  'referenceNumber', 'documentType', 'status', 'hold', 'documentDate', 'documentDueDate',
  'origInvoiceDate', 'currencyId', 'amount', 'amountInCurrency', 'balance', 'balanceInCurrency',
  'vatTotal', 'customerRefNumber', 'externalReference', 'invoiceText', 'note', 'paymentReference',
  'cashAccount', 'customerProject', 'postPeriod', 'financialPeriod', 'createdDateTime',
  'lastModifiedDateTime', 'originatorDocRef', 'contractDocRef', 'accountingCostRef',
]

/** An invoice or credit note header with its first lines: every field that could carry an order number. */
function trimDocument(row: unknown): Row {
  const r = (row ?? {}) as Row
  const lines = rows(r.invoiceLines ?? r.lines)
  return {
    ...pick(r, HEADER_KEYS),
    customer: pick(r.customer, ['number', 'name']),
    paymentMethod: pick(r.paymentMethod, ['id', 'description']),
    location: pick(r.location, ['id', 'name', 'countryId']),
    branchNumber: pick(r.branchNumber, ['number', 'name']),
    salesPerson: pick(r.salesPerson, ['id', 'description']),
    applications: rows(r.applications).map((a) =>
      pick(a, ['docType', 'refNbr', 'amountPaid', 'balance', 'paymentRef', 'status', 'applicationDate', 'released']),
    ),
    lineCount: lines.length,
    lines: lines.slice(0, 3).map((l) => ({
      ...pick(l, [
        'lineNumber', 'lineType', 'inventoryNumber', 'description', 'quantity', 'unitPriceInCurrency',
        'amountInCurrency', 'discountAmountInCurrency', 'soOrderType', 'soOrderNbr', 'soShipmentNbr', 'note',
        'externalLink',
      ]),
      account: pick(l.account, ['number', 'description']),
      vatCode: pick(l.vatCode, ['id', 'description']),
    })),
  }
}

/** A customer payment as the ledger holds it: who, what account, what it settled. */
function trimPayment(row: unknown, lineCap = 8): Row {
  const r = (row ?? {}) as Row
  const lines = rows(r.paymentLines)
  return {
    ...pick(r, [
      'type', 'refNbr', 'status', 'hold', 'applicationDate', 'applicationPeriod', 'paymentRef', 'cashAccount',
      'currency', 'paymentAmount', 'invoiceText', 'appliedToDocuments', 'appliedToOrders', 'availableBalance',
      'writeOffAmount', 'financeCharges', 'deductedCharges', 'branch', 'lastModifiedDateTime',
    ]),
    customer: pick(r.customer, ['number', 'name']),
    paymentMethod: pick(r.paymentMethod, ['id', 'description']),
    lineCount: lines.length,
    lines: lines.slice(0, lineCap).map((l) =>
      pick(l, ['documentType', 'refNbr', 'amountPaid', 'balance', 'customerOrder', 'description', 'currency', 'date']),
    ),
  }
}

const dates = (list: Row[]): [string, string] => {
  const ds = list.map((r) => day(r.documentDate)).filter(Boolean).sort()
  return [ds[0] ?? '', ds[ds.length - 1] ?? '']
}

/** The stored answer of the ledger step, or null when it is missing or was a refusal. */
async function webshopCustomers(ctx: Ctx): Promise<WebshopCustomer[] | null> {
  const found = (await ctx.stored('webkunde-customers')) as { webshop?: WebshopCustomer[] } | null
  return Array.isArray(found?.webshop) ? found.webshop : null
}

const DOC_FILTER = (since: string) =>
  `documentDate=${since}&documentDateCondition=${enc('>')}&expandApplications=true&pageSize=100`

/**
 * The questions, in the order they are asked. Cheap configuration lists
 * first, then the ledger, then the reads that depend on what the ledger said.
 */
export const VISMA_PROBE_STEPS: ProbeStep[] = [
  {
    name: 'cashaccount',
    calls: 1,
    run: async ({ get }) => {
      const list = rows(await get('controller/api/v1/cashaccount'))
      return {
        rows: list.length,
        accounts: list.map((a) => ({
          ...pick(a, ['number', 'description', 'currency', 'lastModifiedDateTime']),
          account: pick(a.account, ['number', 'description', 'type']),
          subaccount: pick(a.subaccount, ['subaccountNumber', 'description']),
          entryTypes: rows(a.entryTypes).map((e) => ({
            ...pick(e, ['entryTypeId', 'disableReceipt', 'module', 'description', 'useForPaymentsReclasification', 'taxCalculationMode']),
            defaultOffsetAccount: pick(e.defaultOffsetAccount, ['number', 'description']),
            defaultOffsetSubaccount: pick(e.defaultOffsetSubaccount, ['subaccountNumber', 'description']),
          })),
        })),
      }
    },
  },
  {
    name: 'paymentmethod',
    calls: 1,
    run: async ({ get }) => {
      const list = rows(await get('controller/api/v1/paymentmethod'))
      return {
        rows: list.length,
        methods: list.map((m) => pick(m, ['paymentMethodID', 'active', 'meansOfPayment', 'description', 'useInAP'])),
      }
    },
  },
  {
    name: 'branch-ledger',
    calls: 2,
    run: async ({ get }) => {
      const branches = rows(await get('controller/api/v1/branch?expandLedger=true&expandCurrency=true'))
      const ledgers = rows(await get('controller/api/v1/ledger'))
      return {
        branches: branches.map((b) =>
          without(b, ['mainAddress', 'mainContact', 'deliveryAddress', 'deliveryContact', 'metadata']),
        ),
        ledgers: ledgers.map((l) => pick(l, ['number', 'description', 'balanceType', 'currencyId', 'branchAccounting'])),
      }
    },
  },
  {
    name: 'webkunde-customers',
    calls: 1,
    run: async ({ get }) => {
      const list = rows(await get('controller/api/v1/customerdocument?status=Open&pageSize=1000&pageNumber=1'))
      return { ...summariseWebshopCustomers(list), sample: list.slice(0, 2) }
    },
  },
  {
    // The payout in the design: Panetti Denmark, 21-27 Aug 2026, orders
    // 14238, 14233, 14244 at DKK 2 999 / 3 747 / 2 999. Which invoice field
    // names them is the join the whole feature stands on.
    name: 'dk-invoices',
    calls: 1,
    run: async (ctx) => {
      const customers = await webshopCustomers(ctx)
      const customer = customers && pickWebshopCustomer(customers, /panetti/i, /danmark|denmark|\bdk\b/i, 'DKK')
      if (!customer) return { error: 'no Denmark webshop customer in the open ledger', customers }
      const path = `controller/api/v1/customerinvoice?customer=${enc(customer.number)}&${DOC_FILTER('2026-08-15')}`
      const list = rows(await ctx.get(path))
      return { customer, path, rows: list.length, dates: dates(list), invoices: list.map(trimDocument) }
    },
  },
  {
    // How settlements are booked today: payments to that house account this
    // year, then every payment since August across all customers.
    name: 'dk-payments',
    calls: 2,
    run: async (ctx) => {
      const customers = await webshopCustomers(ctx)
      const customer = customers && pickWebshopCustomer(customers, /panetti/i, /danmark|denmark|\bdk\b/i, 'DKK')
      if (!customer) return { error: 'no Denmark webshop customer in the open ledger', customers }
      const own = rows(
        await ctx.get(
          `controller/api/v1/customerPayment?customer=${enc(customer.number)}&docDate=2026-01-01&docDateCondition=${enc('>')}&pageSize=100`,
        ),
      )
      const all = rows(
        await ctx.get(`controller/api/v1/customerPayment?docDate=2026-08-01&docDateCondition=${enc('>')}&pageSize=200`),
      )
      return {
        customer,
        toCustomer: { rows: own.length, payments: own.map((p) => trimPayment(p)) },
        sinceAugust: { rows: all.length, payments: all.slice(0, 200).map((p) => trimPayment(p, 3)) },
      }
    },
  },
  {
    // Refunds: NOK 749.50 back on Panetti Norway 27606 (2026-08-29) and the
    // full SEK 4 999 on Panetti Sweden 13580 (2026-08-24). Do credit notes
    // exist for them, and how are they tied to the invoice?
    name: 'refund-creditnotes',
    calls: 2,
    run: async (ctx) => {
      const customers = await webshopCustomers(ctx)
      if (!customers) return { error: 'no webshop customers in the open ledger' }
      const read = async (brand: RegExp, country: RegExp, currency: string, since: string) => {
        const customer = pickWebshopCustomer(customers, brand, country, currency)
        if (!customer) return { error: `no ${currency} webshop customer` }
        const path = `controller/api/v1/customerCreditNote?customer=${enc(customer.number)}&${DOC_FILTER(since)}`
        const list = rows(await ctx.get(path))
        return { customer, path, rows: list.length, dates: dates(list), notes: list.map(trimDocument) }
      }
      return {
        norway: await read(/panetti/i, /norge|norway|\bno\b/i, 'NOK', '2026-08-10'),
        sweden: await read(/panetti/i, /sverige|sweden|\bse\b/i, 'SEK', '2026-08-15'),
      }
    },
  },
  {
    // May the production credentials WRITE? The create and update scopes were
    // approved in the Developer Portal on 2026-09-03; the token endpoint is
    // the proof that the company has accepted them too. Last, and one call.
    name: 'write-scope',
    calls: 1,
    run: async ({ scopeCheck }) => ({
      requested: WRITE_SCOPES,
      ...(await scopeCheck(WRITE_SCOPES)),
      checkedAt: new Date().toISOString(),
    }),
    // Asked every run until granted: production answered invalid_scope on
    // 2026-09-03 15:16Z with both scopes Approved in the Developer Portal, so
    // the missing piece is the company's acceptance, which arrives on its
    // own schedule. One token request a tick costs nothing measurable.
    again: (stored) => (stored as { granted?: boolean } | null)?.granted !== true,
  },
]

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Stored as plain JSON: `undefined` inside a payload is dropped, never sent. */
async function store(step: string, payload: unknown): Promise<void> {
  const value = JSON.parse(JSON.stringify(payload ?? {})) as Prisma.InputJsonValue
  await db.diagnosticSnapshot.upsert({
    where: { key: probeKey(step) },
    create: { key: probeKey(step), payload: value },
    update: { payload: value, takenAt: new Date() },
  })
}

/**
 * Ask the next unanswered questions, a few calls at a time. Never throws.
 */
export async function runVismaProbe(
  opts: { maxCalls?: number; deadline?: number; pauseMs?: number } = {},
): Promise<VismaProbeResult> {
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS
  const names = VISMA_PROBE_STEPS.map((s) => s.name)

  const creds = vismaCredentials()
  if (!creds) return { configured: false, ran: [], pending: names, calls: 0, partial: false, error: null }

  const ran: string[] = []
  let calls = 0
  let partial = false
  let error: string | null = null

  try {
    const answered = await db.diagnosticSnapshot.findMany({
      where: { key: { in: names.map(probeKey) } },
      select: { key: true, payload: true },
    })
    // A step is settled when it has an answer it does not want to revisit.
    const existing = new Set(
      answered
        .filter((r) => {
          const step = VISMA_PROBE_STEPS.find((s) => probeKey(s.name) === r.key)
          return !(step?.again?.(r.payload) ?? false)
        })
        .map((r) => r.key),
    )

    const get: Get = async (path) => {
      if (calls > 0 && pauseMs > 0) await pause(pauseMs)
      calls++
      return vismaGet<unknown>(creds, path, { deadline: opts.deadline })
    }
    const stored = async (step: string) =>
      (await db.diagnosticSnapshot.findUnique({ where: { key: probeKey(step) } }))?.payload ?? null
    const scopeCheck = async (scope: string) => {
      if (calls > 0 && pauseMs > 0) await pause(pauseMs)
      calls++
      return vismaScopeCheck(creds, scope, { deadline: opts.deadline })
    }

    for (const step of VISMA_PROBE_STEPS) {
      if (existing.has(probeKey(step.name))) continue
      if (calls + step.calls > maxCalls) break
      if (opts.deadline !== undefined && Date.now() + STEP_MARGIN_MS > opts.deadline) {
        partial = true
        break
      }
      try {
        await store(step.name, await step.run({ get, stored, scopeCheck }))
      } catch (e) {
        if (e instanceof VismaError && e.status === 429) {
          partial = true
          break
        }
        await store(step.name, { error: e instanceof Error ? e.message : String(e) })
      }
      ran.push(step.name)
    }

    const pending = names.filter((n) => !existing.has(probeKey(n)) && !ran.includes(n))
    return { configured: true, ran, pending, calls, partial, error }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Visma probe failed'
    return { configured: true, ran, pending: names.filter((n) => !ran.includes(n)), calls, partial, error }
  }
}
