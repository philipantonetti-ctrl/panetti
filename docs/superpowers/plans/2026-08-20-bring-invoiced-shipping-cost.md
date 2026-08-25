# Bring Invoiced Shipping Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Bring's own invoices and store what each parcel actually cost, so the Cost per parcel card stops asking a person to type the monthly total in.

**Architecture:** Bring's invoice archive lists invoices per customer number; the `MASTER-SPECIFIED_INVOICE` report breaks one invoice into lines carrying `WAYBILL_NUMBER` and `AMOUNT`. `WAYBILL_NUMBER` is `Shipment.trackingNumber`, so the lines join to parcels we already hold. The report API is asynchronous, so the work is split across cron ticks - discover, request, collect - with state in `BringReportRun`. The report has no line identifier, so an invoice's lines are replaced wholesale rather than deduplicated.

**Tech Stack:** TypeScript, Next.js 16 App Router, Prisma 6 on PostgreSQL, Vitest 4, `node:crypto` only. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-bring-invoiced-shipping-cost-design.md`

## Global Constraints

- **Money is integer minor units.** Use `toMinor` from `src/lib/money.ts`. Never a float.
- **Amounts are ex tax.** Store `AMOUNT`, never `TOTAL_INCL_TAX`. VAT was never our money.
- **`AMOUNT` is the money field, not `GrossPrice`.** `GrossPrice` is `0.00` on every line of the real report.
- **Errors are stored, never thrown.** One bad invoice must not fail the run. Follow `src/lib/delivery/sync.ts`.
- **Credentials come from `getDeliveryConfig()`** in `src/lib/delivery/config.ts`. The `BRING_*` variables in `.env` are not read by the app and must not be introduced.
- **All three Mybring headers on every request:** `X-Mybring-API-Uid`, `X-Mybring-API-Key`, `X-Bring-Client-URL`.
- **Every request is deadline-clamped.** Reuse the `requestBudgetMs` shape from `src/lib/bring/client.ts:32`.
- **Test data convention (integration tests):** test files run in parallel against one database. Every integration test file defines its own unique `TAG` and id prefix, scopes all queries to it, and cleans up after itself. See `src/lib/bring/link.integration.test.ts:20-30`.
- **Integration tests go in the `delivery` vitest project, and need no config change.** The `delivery` project already includes `src/lib/{delivery,bring,dhl}/**/*.integration.test.ts` and the `app` project already excludes the same glob, so a new file under `src/lib/bring/` named `*.integration.test.ts` lands in the right project on its own. **Do not add it to `vitest.config.ts`** - the two lists are an exact partition of the suite and a second entry would run the file twice. A new integration test outside those three directories is the only case that needs the config touched.
- **Commit after every task.** Conventional commits, e.g. `feat(delivery): ...`.

---

### Task 1: List a customer's invoices

**Files:**
- Create: `src/lib/bring/invoice-map.ts`
- Create: `src/lib/bring/invoice-map.test.ts`

**Interfaces:**
- Consumes: `toMinor` from `@/lib/money`
- Produces: `type BringInvoice`, `mapInvoices(raw: unknown): BringInvoice[]`

Real response shape, measured 2026-08-20. Note the two date formats in one object - `invoiceDate` is `dd.mm.yyyy`, `dueDate` is ISO. Only `invoiceDate` is needed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { mapInvoices } from './invoice-map'

const raw = {
  invoices: [
    {
      customerNumber: '20020467369',
      invoiceNumber: '4710001522',
      invoiceDate: '31.07.2026',
      dueDate: '2026-08-14',
      amount: '84786.85',
      taxAmount: '21197.02',
      totalAmount: '105983.87',
      currency: 'NOK',
      type: 'Invoice',
      invoiceSpecificationAvailable: true,
    },
    {
      customerNumber: '20020152102',
      invoiceNumber: '4070009812',
      invoiceDate: '31.07.2026',
      dueDate: '2026-08-13',
      amount: '6240.0',
      taxAmount: '0.0',
      totalAmount: '6240.0',
      currency: 'SEK',
      type: 'Invoice',
      invoiceSpecificationAvailable: false,
    },
  ],
}

describe('mapInvoices', () => {
  it('reads amounts as minor units, including a single decimal place', () => {
    const [first, second] = mapInvoices(raw)
    expect(first.amountMinor).toBe(8478685)
    expect(first.taxMinor).toBe(2119702)
    expect(first.totalMinor).toBe(10598387)
    // '6240.0' is one decimal place, not two. parseFloat then scale, never
    // string surgery: '6240.0' read as digits would be 62400.
    expect(second.amountMinor).toBe(624000)
  })

  it('reads invoiceDate as dd.mm.yyyy, not ISO', () => {
    const [first] = mapInvoices(raw)
    expect(first.invoiceDate.toISOString().slice(0, 10)).toBe('2026-07-31')
  })

  it('carries whether a specification exists, because that decides retry or give up', () => {
    const [first, second] = mapInvoices(raw)
    expect(first.specificationAvailable).toBe(true)
    expect(second.specificationAvailable).toBe(false)
  })

  it('returns nothing rather than throwing when the body is not what we expect', () => {
    expect(mapInvoices(null)).toEqual([])
    expect(mapInvoices({})).toEqual([])
    expect(mapInvoices({ invoices: 'no' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-map.test.ts`
Expected: FAIL, "Failed to resolve import ./invoice-map"

- [ ] **Step 3: Write minimal implementation**

```ts
import { toMinor } from '../money'

/** One invoice as the archive reports it. Money in minor units of `currency`. */
export type BringInvoice = {
  customerNumber: string
  invoiceNumber: string
  invoiceDate: Date
  amountMinor: number // ex tax
  taxMinor: number
  totalMinor: number
  currency: string
  /**
   * False means this invoice can never be broken into lines. Recorded rather
   * than retried: invoice 4070009812 (MANUAL_ORDER_OM) is one, measured.
   */
  specificationAvailable: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * `dd.mm.yyyy` at UTC midnight.
 *
 * The archive uses this for `invoiceDate` and ISO for `dueDate`, in the same
 * object. Reading one as the other silently yields month 31.
 */
function ddmmyyyy(value: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!m) return null
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
}

export function mapInvoices(raw: unknown): BringInvoice[] {
  const rows = (raw as { invoices?: unknown })?.invoices
  if (!Array.isArray(rows)) return []

  const out: BringInvoice[] = []
  for (const row of rows as Record<string, unknown>[]) {
    const invoiceNumber = str(row.invoiceNumber)
    const invoiceDate = ddmmyyyy(str(row.invoiceDate))
    const currency = str(row.currency)
    // A row we cannot identify or date is not a row we can act on.
    if (!invoiceNumber || !invoiceDate || !currency) continue

    out.push({
      customerNumber: str(row.customerNumber),
      invoiceNumber,
      invoiceDate,
      amountMinor: toMinor(str(row.amount)),
      taxMinor: toMinor(str(row.taxAmount)),
      totalMinor: toMinor(str(row.totalAmount)),
      currency,
      specificationAvailable: row.invoiceSpecificationAvailable === true,
    })
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoice-map.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoice-map.ts src/lib/bring/invoice-map.test.ts
git commit -m "feat(delivery): read Bring's invoice archive into typed rows"
```

---

### Task 2: Parse the specified invoice report

**Files:**
- Create: `src/lib/bring/invoice-lines.ts`
- Create: `src/lib/bring/invoice-lines.test.ts`
- Create: `src/lib/bring/fixtures/specified-invoice.xml`

**Interfaces:**
- Consumes: `toMinor` from `@/lib/money`, `type BringInvoice` from `./invoice-map`
- Produces: `type SpecifiedLine`, `type SpecifiedInvoice`, `parseSpecifiedInvoice(xml: string): SpecifiedInvoice | null`, `linesReconcile(parsed: SpecifiedInvoice, header: BringInvoice): boolean`

**The fixture.** Build it from the real report by hand: keep the `MetaData` block and **six** `Line` elements - four from one waybill (base service, toll road, fuel surcharge, notification) and two identical lines from a second waybill, so the duplicate case is in the fixture rather than only in prose. Replace every `*NAME*`, `*ADDRESS*`, `*CITY*`, `*POSTAL*`, `*POINT*`, `*COUNTRY*` and `CUST_PO_NUMBER` value with `REDACTED` - `CUST_PO_NUMBER` holds a person's name in the real file. Set the `MetaData` `NumberOfRows` to 6. Make the six `AMOUNT` values sum to exactly `2500.00`, which is the `FIXTURE_TOTAL_MINOR` of 250000 the tests assert on.

Regex parsing, not an XML library: the repo has no XML dependency, the document is machine-generated and flat, and this was proven against the real 580 KB file before the plan was written.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSpecifiedInvoice, linesReconcile } from './invoice-lines'
import type { BringInvoice } from './invoice-map'

const xml = readFileSync(join(__dirname, 'fixtures/specified-invoice.xml'), 'utf8')

/** Sum of the six fixture lines' AMOUNT, in minor units. */
const FIXTURE_TOTAL_MINOR = 250000

const header = (over: Partial<BringInvoice> = {}): BringInvoice => ({
  customerNumber: '20020467369',
  invoiceNumber: '4710001522',
  invoiceDate: new Date('2026-07-31T00:00:00Z'),
  amountMinor: FIXTURE_TOTAL_MINOR,
  taxMinor: 0,
  totalMinor: FIXTURE_TOTAL_MINOR,
  currency: 'NOK',
  specificationAvailable: true,
  ...over,
})

describe('parseSpecifiedInvoice', () => {
  it('reads every line, keeping duplicates apart', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines).toHaveLength(6)
  })

  it('keeps two identical lines as two, because the report has no line id', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    const counts = new Map<string, number>()
    for (const l of parsed.lines) {
      const key = [l.waybillNumber, l.itemNumber, l.description, l.amountMinor].join('|')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    // Waybill 73325383643994654 is billed twice identically in the fixture, as
    // it is three times over in the real invoice. Collapsing those would
    // under-report that parcel.
    expect([...counts.values()]).toContain(2)
  })

  it('takes AMOUNT as the money, never GrossPrice', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    // GrossPrice is 0.00 on every line of the real report.
    expect(parsed.lines.every((l) => l.amountMinor >= 0)).toBe(true)
    expect(parsed.lines.reduce((n, l) => n + l.amountMinor, 0)).toBe(FIXTURE_TOTAL_MINOR)
  })

  it('reads the currency from the line, not from a guess', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines[0].currency).toBe('NOK')
  })

  it('reads TRX_DATE as dd.mm.yyyy', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(parsed.lines[0].chargedAt.toISOString().slice(0, 10)).toBe('2026-07-31')
  })

  it('returns null for a body that is not a report', () => {
    expect(parseSpecifiedInvoice('')).toBeNull()
    expect(parseSpecifiedInvoice('<html>gateway error</html>')).toBeNull()
  })
})

describe('linesReconcile', () => {
  it('accepts a report whose lines sum to the invoice header', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(linesReconcile(parsed, header())).toBe(true)
  })

  it('rejects a short read, which is what a truncated download looks like', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    const short = { ...parsed, lines: parsed.lines.slice(0, 3) }
    expect(linesReconcile(short, header())).toBe(false)
  })

  it('rejects lines in a currency the invoice was not raised in', () => {
    const parsed = parseSpecifiedInvoice(xml)!
    expect(linesReconcile(parsed, header({ currency: 'SEK' }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-lines.test.ts`
Expected: FAIL, "Failed to resolve import ./invoice-lines"

- [ ] **Step 3: Write minimal implementation**

```ts
import { toMinor } from '../money'
import type { BringInvoice } from './invoice-map'

/** One charge on one parcel. Money in minor units of `currency`, ex tax. */
export type SpecifiedLine = {
  waybillNumber: string
  amountMinor: number
  currency: string
  chargedAt: Date
  itemNumber: string
  description: string
}

export type SpecifiedInvoice = {
  invoiceNumber: string
  customerNumber: string
  lines: SpecifiedLine[]
}

const tag = (body: string, name: string): string => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return m ? m[1].trim() : ''
}

function ddmmyyyy(value: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!m) return null
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
}

/**
 * The specified invoice report, as lines.
 *
 * Regex rather than an XML parser: no XML dependency exists in this repo, the
 * document is machine-generated and flat, and a gateway's HTML error page must
 * come back as null rather than as a parse exception.
 *
 * Every line is kept, duplicates included. The report carries NO line
 * identifier - TRX_NUMBER, the only candidate, is the invoice number repeated
 * on every row - so two identical charges on one parcel are two real charges
 * and merging them loses money that was really billed.
 */
export function parseSpecifiedInvoice(xml: string): SpecifiedInvoice | null {
  if (!xml.includes('<Line>')) return null

  const invoiceNumber = tag(xml, 'InvoiceNumber')
  const customerNumber = tag(xml, 'CustomerId')
  if (!invoiceNumber) return null

  const lines: SpecifiedLine[] = []
  for (const m of xml.matchAll(/<Line>([\s\S]*?)<\/Line>/g)) {
    const body = m[1]
    const waybillNumber = tag(body, 'WAYBILL_NUMBER')
    const chargedAt = ddmmyyyy(tag(body, 'TRX_DATE'))
    const currency = tag(body, 'INVOICE_CURRENCY_CODE')
    if (!waybillNumber || !chargedAt || !currency) continue

    lines.push({
      waybillNumber,
      // AMOUNT, deliberately. GrossPrice is documented as the price and is
      // 0.00 on all 144 lines of the real report.
      amountMinor: toMinor(tag(body, 'AMOUNT')),
      currency,
      chargedAt,
      itemNumber: tag(body, 'ITEM_NUMBER'),
      description: tag(body, 'ITEM_DESCRIPTION'),
    })
  }

  return { invoiceNumber, customerNumber, lines }
}

/**
 * Do these lines account for the whole invoice?
 *
 * Measured on the real report: the 144 line AMOUNTs sum to 84 786.85, exactly
 * the header's `amount`. So exact equality is the right test, and a mismatch
 * means a truncated download, a changed format, or an invoice we half-read -
 * all of which look identical to a cheap month once stored.
 */
export function linesReconcile(parsed: SpecifiedInvoice, header: BringInvoice): boolean {
  if (parsed.lines.length === 0) return false
  if (parsed.lines.some((l) => l.currency !== header.currency)) return false
  return parsed.lines.reduce((n, l) => n + l.amountMinor, 0) === header.amountMinor
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoice-lines.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoice-lines.ts src/lib/bring/invoice-lines.test.ts src/lib/bring/fixtures/specified-invoice.xml
git commit -m "feat(delivery): parse a Bring specified invoice into parcel charges"
```

---

### Task 3: The HTTP client

**Files:**
- Create: `src/lib/bring/invoices.ts`
- Create: `src/lib/bring/invoices.test.ts`

**Interfaces:**
- Consumes: `type BringCredentials` and `requestBudgetMs` from `./client`, `mapInvoices` and `type BringInvoice` from `./invoice-map`
- Produces: `listInvoices(creds, customerNumber, opts?): Promise<BringInvoice[]>`, `listCustomerNumbers(creds, opts?): Promise<string[]>`, `generateSpecReport(creds, customerNumber, invoiceNumber, opts?): Promise<string>`, `reportStatus(creds, statusUrl, opts?): Promise<{ done: boolean; xmlUrl: string | null }>`, `downloadReport(creds, xmlUrl, opts?): Promise<string>`

Endpoints, all verified live on 2026-08-20:

| what | method and URL |
|---|---|
| customer numbers | `GET https://www.mybring.com/reports/api/generate` |
| invoices | `GET https://www.mybring.com/invoicearchive/api/invoices/{customerNumber}.json` |
| generate | `GET https://www.mybring.com/reports/api/generate/{customerNumber}/MASTER-SPECIFIED_INVOICE/?invoiceNumber={n}` → 202 + `statusUrl` |
| status | `GET {statusUrl}` → `{ status, xlsUrl, xmlUrl }` |
| download | `GET {xmlUrl}` with `Accept: application/xml` |

Enumerate customer numbers through **`reports/api/generate`, not Customer Info**: Customer Info returned three, Reports returned four. The Swedish entity appears only in the latter.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  listInvoices, listCustomerNumbers, generateSpecReport, reportStatus, downloadReport,
} from './invoices'

const creds = { uid: 'ops@example.com', key: 'secret-key', clientUrl: 'https://panetti.vercel.app' }

afterEach(() => vi.unstubAllGlobals())

// Typed exactly as src/lib/bring/client.test.ts does, so fn.mock.calls[0][1]
// is not an index into an empty tuple under `next build`'s typecheck.
function stub(status: number, body: string) {
  const fn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('listCustomerNumbers', () => {
  it('reads every customer the Reports API offers', async () => {
    stub(200, JSON.stringify({ customer: [{ id: '20007277815' }, { id: '20012412431' }] }))
    expect(await listCustomerNumbers(creds)).toEqual(['20007277815', '20012412431'])
  })
})

describe('listInvoices', () => {
  it('sends the three Mybring headers', async () => {
    const fn = stub(200, JSON.stringify({ invoices: [] }))
    await listInvoices(creds, '20020467369')
    const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Mybring-API-Uid']).toBe('ops@example.com')
    expect(headers['X-Mybring-API-Key']).toBe('secret-key')
    expect(headers['X-Bring-Client-URL']).toBe('https://panetti.vercel.app')
  })

  it('asks the invoice archive for that customer number', async () => {
    const fn = stub(200, JSON.stringify({ invoices: [] }))
    await listInvoices(creds, '20020467369')
    expect(String(fn.mock.calls[0][0])).toBe(
      'https://www.mybring.com/invoicearchive/api/invoices/20020467369.json',
    )
  })

  it('throws with the status and a truncated body, never the whole page', async () => {
    stub(403, 'x'.repeat(5000))
    await expect(listInvoices(creds, '20020467369')).rejects.toThrow(/403/)
  })
})

describe('generateSpecReport', () => {
  it('passes the invoice number, which is the report\'s only parameter', async () => {
    const fn = stub(202, JSON.stringify({ statusUrl: 'https://www.mybring.com/s/1/status/' }))
    const url = await generateSpecReport(creds, '20020467369', '4710001522')
    expect(String(fn.mock.calls[0][0])).toContain(
      '/reports/api/generate/20020467369/MASTER-SPECIFIED_INVOICE/?invoiceNumber=4710001522',
    )
    expect(url).toBe('https://www.mybring.com/s/1/status/')
  })
})

describe('reportStatus', () => {
  it('reports done with the xml url', async () => {
    stub(200, JSON.stringify({ status: 'DONE', xmlUrl: 'https://www.mybring.com/r/1.xml' }))
    expect(await reportStatus(creds, 'https://www.mybring.com/s/1/status/')).toEqual({
      done: true,
      xmlUrl: 'https://www.mybring.com/r/1.xml',
    })
  })

  it('reports not done without throwing, so the next tick tries again', async () => {
    stub(200, JSON.stringify({ status: 'NOT_DONE' }))
    expect(await reportStatus(creds, 'https://www.mybring.com/s/1/status/')).toEqual({
      done: false, xmlUrl: null,
    })
  })

  it('treats FAILED as done with nothing to download, so it is not polled forever', async () => {
    stub(200, JSON.stringify({ status: 'FAILED' }))
    expect(await reportStatus(creds, 'https://www.mybring.com/s/1/status/')).toEqual({
      done: true, xmlUrl: null,
    })
  })
})

describe('downloadReport', () => {
  it('asks for xml and returns it as text', async () => {
    const fn = stub(200, '<Report><Line></Line></Report>')
    const xml = await downloadReport(creds, 'https://www.mybring.com/r/1.xml')
    const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Accept).toBe('application/xml')
    expect(xml).toContain('<Line>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoices.test.ts`
Expected: FAIL, "Failed to resolve import ./invoices"

- [ ] **Step 3: Write minimal implementation**

```ts
import { requestBudgetMs, type BringCredentials, type BringFilter } from './client'
import { mapInvoices, type BringInvoice } from './invoice-map'

/**
 * Bring's money endpoints, over HTTP.
 *
 * A different host from tracking - www.mybring.com rather than api.bring.com -
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
 * Info returned three numbers and Reports returned four - the Swedish entity
 * appears only here. Enumerating through the other one loses a whole company's
 * freight with nothing on screen to say so.
 */
export async function listCustomerNumbers(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<string[]> {
  const res = await get(creds, `${BASE}/reports/api/generate`, opts)
  const body = (await res.json()) as { customer?: { id?: unknown }[] }
  return (body.customer ?? [])
    .map((c) => (typeof c.id === 'string' ? c.id : ''))
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoices.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoices.ts src/lib/bring/invoices.test.ts
git commit -m "feat(delivery): a client for Bring's invoice archive and report API"
```

---

### Task 4: The schema

**Files:**
- Modify: `prisma/schema.prisma` (append after `model CarrierCost`)

**Interfaces:**
- Produces: `db.shipmentCost`, `db.bringReportRun`

- [ ] **Step 1: Add both models**

Copy the two models verbatim from the spec's "What we store" section, including their doc comments. The comments carry the measured evidence for why `ShipmentCost` has no unique constraint; do not summarise them away.

- [ ] **Step 2: Push the schema to the local database**

Run: `npm run db:push`
Expected: exit 0, both tables created. `db push` refuses destructive changes without a flag, so a refusal here means something in the models collides with an existing table - read the message rather than adding the flag.

- [ ] **Step 3: Verify the client regenerated**

Run: `npx tsc --noEmit`
Expected: exit 0. `postinstall` runs `prisma generate`, but `db:push` regenerates too; this proves `db.shipmentCost` exists on the typed client.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(delivery): store what Bring invoiced per parcel"
```

---

### Task 5: Discover - invoices become jobs

**Files:**
- Create: `src/lib/bring/invoice-sync.ts`
- Create: `src/lib/bring/invoice-sync.integration.test.ts` (no `vitest.config.ts` change - the `delivery` project's existing glob already claims it)

**Interfaces:**
- Consumes: `listCustomerNumbers`, `listInvoices` from `./invoices`; `db` from `@/lib/db`
- Produces: `discoverInvoices(creds, opts?): Promise<{ found: number; queued: number; noSpec: number }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { discoverInvoices } from './invoice-sync'

// Unique to THIS file - see "Test data convention" in the Global Constraints.
const CUST = 'ZZDISC'
const mine = { customerNumber: { startsWith: CUST } }
const creds = { uid: 'u', key: 'k', clientUrl: 'https://panetti.vercel.app' }

const cleanup = async () => { await db.bringReportRun.deleteMany({ where: mine }) }
beforeEach(cleanup)
afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())

function stubApi(invoices: unknown[]) {
  vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
    async (u) => {
      const url = String(u)
      if (url.endsWith('/reports/api/generate')) {
        return new Response(JSON.stringify({ customer: [{ id: `${CUST}1` }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ invoices }), { status: 200 })
    },
  ))
}

const invoice = (n: string, spec: boolean) => ({
  customerNumber: `${CUST}1`, invoiceNumber: n, invoiceDate: '31.07.2026',
  amount: '100.00', taxAmount: '0.00', totalAmount: '100.00', currency: 'NOK',
  type: 'Invoice', invoiceSpecificationAvailable: spec,
})

describe('discoverInvoices', () => {
  it('queues an invoice that has a specification', async () => {
    stubApi([invoice(`${CUST}-A`, true)])
    const result = await discoverInvoices(creds)
    expect(result.queued).toBe(1)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-A` } })
    expect(row?.state).toBe('PENDING')
  })

  it('records an invoice without a specification as NO_SPEC, not as a failure', async () => {
    stubApi([invoice(`${CUST}-B`, false)])
    const result = await discoverInvoices(creds)
    expect(result.noSpec).toBe(1)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-B` } })
    // Terminal. Retrying it every tick forever would be the alternative.
    expect(row?.state).toBe('NO_SPEC')
  })

  it('is idempotent, so running twice does not re-queue a stored invoice', async () => {
    stubApi([invoice(`${CUST}-C`, true)])
    await discoverInvoices(creds)
    await db.bringReportRun.update({
      where: { invoiceNumber: `${CUST}-C` }, data: { state: 'STORED' },
    })
    const second = await discoverInvoices(creds)
    expect(second.queued).toBe(0)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-C` } })
    expect(row?.state).toBe('STORED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts`
Expected: FAIL, "Failed to resolve import ./invoice-sync"

- [ ] **Step 3: Write minimal implementation**

```ts
import { db } from '../db'
import type { BringCredentials, BringFilter } from './client'
import { listCustomerNumbers, listInvoices } from './invoices'

/**
 * Turn every invoice we have not seen into a job.
 *
 * Cheap: one call to enumerate customers, one per customer to list invoices.
 * It writes nothing but rows, so a tick that discovers and then runs out of
 * time has still moved the work forward.
 */
export async function discoverInvoices(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<{ found: number; queued: number; noSpec: number }> {
  let found = 0
  let queued = 0
  let noSpec = 0

  for (const customerNumber of await listCustomerNumbers(creds, opts)) {
    for (const invoice of await listInvoices(creds, customerNumber, opts)) {
      found += 1
      // A row we already hold is left exactly as it is: it may be STORED, and
      // rediscovering an invoice must never send it round the loop again.
      const held = await db.bringReportRun.findUnique({
        where: { invoiceNumber: invoice.invoiceNumber },
        select: { id: true },
      })
      if (held) continue

      const state = invoice.specificationAvailable ? 'PENDING' : 'NO_SPEC'
      await db.bringReportRun.create({
        data: {
          customerNumber: invoice.customerNumber || customerNumber,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          state,
        },
      })
      if (state === 'PENDING') queued += 1
      else noSpec += 1
    }
  }

  return { found, queued, noSpec }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoice-sync.ts src/lib/bring/invoice-sync.integration.test.ts
git commit -m "feat(delivery): turn every unseen Bring invoice into a job"
```

---

### Task 6: Request - the oldest pending job gets a report

**Files:**
- Modify: `src/lib/bring/invoice-sync.ts`
- Modify: `src/lib/bring/invoice-sync.integration.test.ts`

**Interfaces:**
- Consumes: `generateSpecReport` from `./invoices`
- Produces: `requestNextReport(creds, opts?): Promise<boolean>` - true when one was requested

- [ ] **Step 1: Write the failing test**

```ts
describe('requestNextReport', () => {
  it('requests the oldest pending invoice first, so nothing starves', async () => {
    const older = new Date('2026-06-30T00:00:00Z')
    const newer = new Date('2026-07-31T00:00:00Z')
    await db.bringReportRun.createMany({
      data: [
        { customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-NEW`, invoiceDate: newer, state: 'PENDING' },
        { customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-OLD`, invoiceDate: older, state: 'PENDING' },
      ],
    })
    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ statusUrl: 'https://www.mybring.com/s/9/status/' }), { status: 202 }),
    ))

    expect(await requestNextReport(creds)).toBe(true)
    const old = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-OLD` } })
    expect(old?.state).toBe('REQUESTED')
    expect(old?.statusUrl).toBe('https://www.mybring.com/s/9/status/')
    const fresh = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-NEW` } })
    expect(fresh?.state).toBe('PENDING')
  })

  it('answers false when there is nothing pending, without calling Bring', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    expect(await requestNextReport(creds)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('stores the failure on the row rather than throwing, so one bad invoice does not stop the run', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-BAD`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'PENDING',
      },
    })
    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async () => new Response('nope', { status: 500 }),
    ))

    await expect(requestNextReport(creds)).resolves.toBe(true)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-BAD` } })
    expect(row?.state).toBe('FAILED')
    expect(row?.error).toContain('500')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts -t requestNextReport`
Expected: FAIL, "requestNextReport is not a function"

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Ask Bring to build one report.
 *
 * Oldest first, the same fairness rule syncAllShops and syncShipments follow:
 * without it a run that cannot reach everything starves the same rows every
 * time, forever.
 *
 * Returns whether a row was worked on at all - a failure still counts, because
 * the tick did its one unit of work and the row now says why.
 */
export async function requestNextReport(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<boolean> {
  const next = await db.bringReportRun.findFirst({
    where: { state: 'PENDING' },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!next) return false

  try {
    const statusUrl = await generateSpecReport(creds, next.customerNumber, next.invoiceNumber, opts)
    await db.bringReportRun.update({
      where: { id: next.id },
      data: { state: 'REQUESTED', statusUrl, requestedAt: new Date(), error: null },
    })
  } catch (e) {
    // Stored, never thrown. One dead invoice must not stop the rest - the same
    // rule delivery/sync.ts follows for one dead parcel.
    await db.bringReportRun.update({
      where: { id: next.id },
      data: { state: 'FAILED', error: e instanceof Error ? e.message : String(e) },
    })
  }
  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoice-sync.ts src/lib/bring/invoice-sync.integration.test.ts
git commit -m "feat(delivery): request one specified invoice report per run, oldest first"
```

---

### Task 7: Collect - download, reconcile, replace

**Files:**
- Modify: `src/lib/bring/invoice-sync.ts`
- Modify: `src/lib/bring/invoice-sync.integration.test.ts`

**Interfaces:**
- Consumes: `reportStatus`, `downloadReport`, `listInvoices` from `./invoices`; `parseSpecifiedInvoice`, `linesReconcile` from `./invoice-lines`
- Produces: `collectNextReport(creds, opts?): Promise<{ stored: number; unmatched: number } | null>`

The header needed for reconciliation is re-read from the archive at collect time rather than stored on the job row, so a re-issued invoice reconciles against its current total rather than a stale one.

- [ ] **Step 1: Write the failing test**

```ts
describe('collectNextReport', () => {
  it('replaces an invoice\'s lines wholesale, so a re-read is a no-op not a duplicate', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-R`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    stubCollect(`${CUST}-R`)

    await collectNextReport(creds)
    const first = await db.shipmentCost.count({ where: { invoiceNumber: `${CUST}-R` } })

    await db.bringReportRun.update({
      where: { invoiceNumber: `${CUST}-R` },
      data: { state: 'REQUESTED' },
    })
    stubCollect(`${CUST}-R`)
    await collectNextReport(creds)

    const second = await db.shipmentCost.count({ where: { invoiceNumber: `${CUST}-R` } })
    expect(second).toBe(first)
  })

  it('keeps both of two identical lines, because both were really charged', async () => {
    // The fixture bills one waybill twice at the same amount for the same item.
    // 135 distinct keys for 144 real lines is why this must not be deduplicated.
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-D`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    stubCollect(`${CUST}-D`)
    await collectNextReport(creds)

    const rows = await db.shipmentCost.findMany({ where: { invoiceNumber: `${CUST}-D` } })
    const dupes = rows.filter((r) => r.trackingNumber === DUPLICATE_WAYBILL)
    expect(dupes).toHaveLength(2)
  })

  it('refuses a report whose lines do not sum to the invoice, storing nothing', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-S`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    stubCollect(`${CUST}-S`, { headerAmount: '999999.00' })

    await collectNextReport(creds)
    expect(await db.shipmentCost.count({ where: { invoiceNumber: `${CUST}-S` } })).toBe(0)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-S` } })
    expect(row?.state).toBe('FAILED')
    expect(row?.error).toMatch(/reconcile/i)
  })

  it('leaves a report that is not ready for the next tick', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-W`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ status: 'NOT_DONE' }), { status: 200 }),
    ))

    expect(await collectNextReport(creds)).toBeNull()
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-W` } })
    expect(row?.state).toBe('REQUESTED')
  })
})
```

**IMPLEMENTER:** write `stubCollect(invoiceNumber, over?)` beside the other helpers in this file. It stubs `fetch` to answer three URLs: a status URL with `{ status: 'DONE', xmlUrl }`, the xml URL with the fixture XML rewritten so `<InvoiceNumber>` is `invoiceNumber`, and the invoice archive with a single header row whose `amount` is `over?.headerAmount` or the fixture's true total. Export `DUPLICATE_WAYBILL` from the fixture's duplicated waybill value.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts -t collectNextReport`
Expected: FAIL, "collectNextReport is not a function"

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Collect one requested report.
 *
 * Null means nothing was collected - nothing requested, or not ready yet -
 * which is a normal tick, not a problem.
 *
 * The invoice header is re-read here rather than remembered from discovery, so
 * a re-issued invoice reconciles against what it says today.
 */
export async function collectNextReport(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<{ stored: number; unmatched: number } | null> {
  const job = await db.bringReportRun.findFirst({
    where: { state: 'REQUESTED', statusUrl: { not: null } },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!job) return null

  const fail = async (message: string) => {
    await db.bringReportRun.update({
      where: { id: job.id },
      data: { state: 'FAILED', error: message },
    })
    return null
  }

  try {
    const status = await reportStatus(creds, job.statusUrl!, opts)
    if (!status.done) return null
    if (!status.xmlUrl) return fail('Bring built no report for this invoice')

    const parsed = parseSpecifiedInvoice(await downloadReport(creds, status.xmlUrl, opts))
    if (!parsed) return fail('The report could not be read as a specified invoice')

    const header = (await listInvoices(creds, job.customerNumber, opts)).find(
      (i) => i.invoiceNumber === job.invoiceNumber,
    )
    if (!header) return fail('The invoice is no longer in the archive')
    if (!linesReconcile(parsed, header)) {
      // Storing a half-read invoice is indistinguishable from a cheap month.
      return fail(
        `The report's lines do not reconcile with the invoice total (${header.amountMinor} minor units)`,
      )
    }

    // Wholesale replace. The report carries no line identifier, so this - not a
    // unique constraint - is what makes re-reading safe.
    const { count } = await db.$transaction(async (tx) => {
      await tx.shipmentCost.deleteMany({ where: { invoiceNumber: job.invoiceNumber } })
      return tx.shipmentCost.createMany({
        data: parsed.lines.map((l) => ({
          trackingNumber: l.waybillNumber,
          customerNumber: job.customerNumber,
          invoiceNumber: job.invoiceNumber,
          amount: l.amountMinor,
          currency: l.currency,
          chargedAt: l.chargedAt,
          itemNumber: l.itemNumber,
          description: l.description,
        })),
      })
    })

    // How much of this invoice we could not attach to a parcel we hold. Counted
    // rather than hidden: it is the number that says whether the join works.
    const known = await db.shipment.findMany({
      where: { trackingNumber: { in: [...new Set(parsed.lines.map((l) => l.waybillNumber))] } },
      select: { trackingNumber: true },
    })
    const have = new Set(known.map((s) => s.trackingNumber))
    const unmatched = parsed.lines.filter((l) => !have.has(l.waybillNumber)).length

    await db.bringReportRun.update({
      where: { id: job.id },
      data: {
        state: 'STORED', collectedAt: new Date(),
        rowsStored: count, rowsUnmatched: unmatched, error: null,
      },
    })
    return { stored: count, unmatched }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/bring/invoice-sync.ts src/lib/bring/invoice-sync.integration.test.ts
git commit -m "feat(delivery): collect a specified invoice and replace its lines wholesale"
```

---

### Task 8: One tick of the cycle, wired into the cron

**Files:**
- Modify: `src/lib/bring/invoice-sync.ts`
- Modify: `src/lib/bring/invoice-sync.integration.test.ts`
- Modify: `src/app/api/cron/sync/route.ts`

**Interfaces:**
- Consumes: `getDeliveryConfig` from `@/lib/delivery/config`
- Produces: `syncBringInvoices(opts?): Promise<BringInvoiceSyncResult>` where `BringInvoiceSyncResult = { configured: boolean; found: number; queued: number; noSpec: number; requested: boolean; stored: number; unmatched: number; error: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
describe('syncBringInvoices', () => {
  it('does nothing and says so when Bring is not connected', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    // No DeliveryConfig credentials in this test database.
    const result = await syncBringInvoices()
    expect(result.configured).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('discovers, requests and collects at most one each per tick', async () => {
    // Proves the run cost is bounded: a hundred pending invoices must not make
    // one tick a hundred requests long.
    await db.bringReportRun.createMany({
      data: [1, 2, 3].map((n) => ({
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-T${n}`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'PENDING',
      })),
    })
    stubTick()
    await syncBringInvoices()
    expect(await db.bringReportRun.count({ where: { ...mine, state: 'REQUESTED' } })).toBe(1)
  })
})
```

**IMPLEMENTER:** `syncBringInvoices` reads credentials through `getDeliveryConfig()`. For the second test, write the `DeliveryConfig` singleton with an encrypted key via `encryptSecret` from `@/lib/secrets`, and restore it in `afterAll` - that row is shared, which is why this file belongs in the `delivery` project.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/bring/invoice-sync.integration.test.ts -t syncBringInvoices`
Expected: FAIL, "syncBringInvoices is not a function"

- [ ] **Step 3: Write minimal implementation**

```ts
export type BringInvoiceSyncResult = {
  configured: boolean
  found: number
  queued: number
  noSpec: number
  requested: boolean
  stored: number
  unmatched: number
  error: string | null
}

const nothing = (over: Partial<BringInvoiceSyncResult> = {}): BringInvoiceSyncResult => ({
  configured: true, found: 0, queued: 0, noSpec: 0,
  requested: false, stored: 0, unmatched: 0, error: null, ...over,
})

/**
 * One tick: discover, request one, collect one.
 *
 * Deliberately at most one of each. The report API is asynchronous and this
 * runs inside a 300-second invocation that the shop sync, four Visma imports,
 * the parcel poll and the delivery alert also have to fit into. A backlog
 * clears over several hours of ticks, which costs nobody anything; a tick that
 * ran the whole backlog would cost the delivery alert its margin.
 */
export async function syncBringInvoices(
  opts: BringFilter = {},
): Promise<BringInvoiceSyncResult> {
  const { creds } = await getDeliveryConfig()
  if (!creds) return nothing({ configured: false })

  try {
    const found = await discoverInvoices(creds, opts)
    const requested = await requestNextReport(creds, opts)
    const collected = await collectNextReport(creds, opts)
    return nothing({
      found: found.found, queued: found.queued, noSpec: found.noSpec,
      requested,
      stored: collected?.stored ?? 0,
      unmatched: collected?.unmatched ?? 0,
    })
  } catch (e) {
    return nothing({ error: e instanceof Error ? e.message : String(e) })
  }
}
```

- [ ] **Step 4: Wire it into the cron**

In `src/app/api/cron/sync/route.ts`, after the four Visma imports and **before** `syncShipments`, add the same best-effort shape the Visma imports already use:

```ts
let bringInvoices: BringInvoiceSyncResult = {
  configured: false, found: 0, queued: 0, noSpec: 0,
  requested: false, stored: 0, unmatched: 0, error: null,
}
try {
  bringInvoices = await syncBringInvoices({ deadline: runStartedAt + BRING_INVOICES_DEADLINE_MS })
} catch {
  // syncBringInvoices does not throw, but a caller that assumes so is one
  // refactor away from a failed sync.
}
```

with, beside the other deadline constants and carrying a comment in their voice:

```ts
/**
 * Bring's invoices are finished by this point in the run.
 *
 * Before the parcel poll, because freight history is money and a parcel checked
 * twenty minutes late costs nobody anything. Bounded well short of the poll's
 * own deadline because this stage makes at most three requests and a tick that
 * overran would take the poll and the delivery alert with it.
 */
const BRING_INVOICES_DEADLINE_MS = 270_000
```

Add to the JSON response, per reason rather than as a bare total, matching the Visma lines already there:

```ts
bringInvoicesConfigured: bringInvoices.configured,
bringInvoicesQueued: bringInvoices.queued,
bringInvoicesNoSpec: bringInvoices.noSpec,
bringCostsStored: bringInvoices.stored,
// The number that says whether the waybill join actually works. A stored count
// that climbs while this climbs with it means we are reading invoices for
// parcels we do not hold.
bringCostsUnmatched: bringInvoices.unmatched,
bringInvoicesError: bringInvoices.error,
```

- [ ] **Step 5: Run the full suite and the typecheck**

Run: `npx vitest run --testTimeout=20000`
Expected: all files pass. 2-3 red tests in `sync.test.ts` on a loaded machine are contention, not a bug - re-run those alone before investigating.

Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/lib/bring/invoice-sync.ts src/lib/bring/invoice-sync.integration.test.ts src/app/api/cron/sync/route.ts
git commit -m "feat(delivery): read Bring's invoices on the scheduled sync"
```

---

## What this plan deliberately stops before

Slices 3 and 4 of the spec - the Delivery page showing real cost per parcel, and the engine rung that moves profit - are **not planned here**, and not from timidity.

They both depend on one number nobody can know yet: **how many invoice lines actually match a parcel we hold.** The waybills are 17 digits and pass `looksLikeTracking`, but whether production's `Shipment` rows carry those same numbers cannot be tested from a development machine, because production data lives on Neon and the local database holds seed data.

`bringCostsUnmatched` in Task 8 is the answer. One cron run in production reports it. If it is near zero the join works and slices 3 and 4 are straightforward; if it is high, the join needs `SENDER_REFERENCE` or another key and the remaining design changes shape entirely.

Planning a user interface and a change to profit on top of an unverified join would be writing steps around a guess. Run this plan, read that one number, then plan the rest against it.

**One spec item is deliberately deferred with them.** The spec calls for a summed `costMinor` and `costCurrency` denormalised onto `Shipment`, rewritten on each ingest, the way the milestone columns already are. That is a read optimisation and its only reader is the Delivery page in slice 3. Adding it now would mean maintaining a cache nothing reads, and its shape depends on the same unknown: if most lines do not match a parcel, the column is mostly null and the summing rule wants rethinking rather than porting. `ShipmentCost` rows are the truth either way, so nothing is lost by adding the column alongside the screen that needs it.
