import { describe, expect, it, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { collectNextReport, discoverInvoices, requestNextReport, syncBringInvoices, writeBringCosts } from './invoice-sync'
import { getSetting } from '@/lib/settings'

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const CUST = 'ZZDISC'
const mine = { customerNumber: { startsWith: CUST } }
const creds = { uid: 'u', key: 'k', clientUrl: 'https://panetti.vercel.app' }

// Deletes from every table this file (and Tasks 6/7's later additions to it)
// can write. ShipmentCost has no customerNumber prefix of its own to scope
// by, but every invoiceNumber this file creates starts with CUST, so scoping
// there keeps a future test's rows from leaking into the shared database.
// Shipment can't be prefixed at all — trackingNumber has to be a real fixture
// waybill for the join to have anything to match — so it is scoped instead to
// the one literal value (KNOWN_WAYBILL) this file ever creates one for.
const cleanup = async () => {
  await db.bringReportRun.deleteMany({ where: mine })
  await db.shipmentCost.deleteMany({ where: { invoiceNumber: { startsWith: CUST } } })
  await db.shipment.deleteMany({ where: { trackingNumber: KNOWN_WAYBILL } })
  // writeBringCosts writes the REAL carrier name, so the only safe tag is the
  // month. 1999 is a year Bring will never invoice and nothing else touches.
  await db.carrierCost.deleteMany({ where: { month: { startsWith: '1999-' } } })
}
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
      // generateSpecReport's URL, longer than the bare listCustomerNumbers one
      // matched above: .../reports/api/generate/{customerNumber}/MASTER-SPECIFIED_INVOICE/?invoiceNumber=...
      if (url.includes('/reports/api/generate/')) {
        return new Response(JSON.stringify({ statusUrl: 'https://www.mybring.com/s/9/status/' }), { status: 202 })
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

// Task 7's fixture: a real (redacted) specified-invoice report. Six lines,
// four on one waybill and two identical ones on another.
const specifiedInvoiceXml = readFileSync(join(__dirname, 'fixtures/specified-invoice.xml'), 'utf8')

/** The fixture's true total across all six lines, in major units. */
const FIXTURE_TOTAL = '2500.00'

/** The waybill billed twice, identically, in the fixture. */
export const DUPLICATE_WAYBILL = '73325383643994654'

/**
 * The fixture's other waybill, billed on the four lines that are not
 * DUPLICATE_WAYBILL. Holding a Shipment for only this one, never for
 * DUPLICATE_WAYBILL, gives the unmatched-count test a specific, non-symmetric
 * split (4 matched, 2 not) that a distinct-waybill count or an inverted
 * `have.has()` would get wrong.
 */
const KNOWN_WAYBILL = '73325383635034405'

/**
 * Stubs the three calls collectNextReport makes for one job: the status
 * poll, the XML download, and the invoice-archive re-read used for
 * reconciliation. `over.headerAmount` lets a test make the header disagree
 * with the lines, to exercise the reconciliation gate.
 */
function stubCollect(invoiceNumber: string, over?: { headerAmount?: string }) {
  const xmlUrl = 'https://www.mybring.com/s/1/report.xml'
  const xml = specifiedInvoiceXml.replace(
    /<InvoiceNumber>[^<]*<\/InvoiceNumber>/,
    `<InvoiceNumber>${invoiceNumber}</InvoiceNumber>`,
  )
  const amount = over?.headerAmount ?? FIXTURE_TOTAL

  vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
    async (u) => {
      const url = String(u)
      if (url.includes('/invoicearchive/api/invoices/')) {
        return new Response(JSON.stringify({
          invoices: [{ ...invoice(invoiceNumber, true), amount, totalAmount: amount }],
        }), { status: 200 })
      }
      if (url === xmlUrl) {
        return new Response(xml, { status: 200 })
      }
      // Every job in this describe block is created with the same hardcoded
      // statusUrl, so anything left unmatched above is that status poll.
      return new Response(JSON.stringify({ status: 'DONE', xmlUrl }), { status: 200 })
    },
  ))
}

/**
 * Stubs one whole tick of syncBringInvoices: an empty customer list, so
 * discoverInvoices finds nothing new and never calls listInvoices; a
 * successful report request; and a status poll that always answers NOT_DONE.
 * That last part is what keeps collectNextReport from touching the row this
 * tick, so the one request the tick made is still sitting there to count.
 */
function stubTick() {
  vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
    async (u) => {
      const url = String(u)
      if (url.endsWith('/reports/api/generate')) {
        return new Response(JSON.stringify({ customer: [] }), { status: 200 })
      }
      if (url.includes('/reports/api/generate/')) {
        return new Response(JSON.stringify({ statusUrl: 'https://www.mybring.com/s/9/status/' }), { status: 202 })
      }
      return new Response(JSON.stringify({ status: 'NOT_DONE' }), { status: 200 })
    },
  ))
}

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

  it('stops discovering once the deadline has passed, and says so', async () => {
    // Shape matches consignments.test.ts's "stops starting new lookups once
    // the deadline has passed" test: proves no request is even attempted,
    // not merely that one happens to fail.
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    const result = await discoverInvoices(creds, { deadline: Date.now() - 1 })
    expect(fn).not.toHaveBeenCalled()
    // `invoices: []` matters as much as the counts: a partial pass must hand
    // back nothing to total, or writeBringCosts would write a month up from
    // half its invoices.
    expect(result).toEqual({ found: 0, queued: 0, noSpec: 0, partial: true, invoices: [] })
  })
})

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
    // A FAILED row still has to be retried eventually — see the "retries a
    // FAILED row" test below — so it must carry a nextTryAt, not just an error.
    expect(row?.nextTryAt).not.toBeNull()
  })

  // I1(a): requestBudgetMs floors an expired budget at 1ms rather than
  // refusing to run at all, so past the deadline generateSpecReport would
  // abort almost immediately — a throw this function's own catch cannot tell
  // apart from a genuine failure, which would then bury the oldest PENDING
  // row as FAILED every time a tick starves. Checked first, before the row is
  // even read, the same shape discoverInvoices already uses.
  it('does nothing once the deadline has passed, and does not touch the row', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-DL`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'PENDING',
      },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    expect(await requestNextReport(creds, { deadline: Date.now() - 1 })).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-DL` } })
    expect(row?.state).toBe('PENDING')
  })

  // I1(b): FAILED must not be a second terminal state alongside NO_SPEC.
  // Once its backoff has elapsed, a FAILED row is picked up again exactly
  // like a PENDING one — generating it a fresh report — and a successful
  // request clears the old error rather than leaving it to look current.
  it('retries a FAILED row once its backoff has elapsed, clearing its error', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-RETRY`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'FAILED',
        error: 'Bring responded 500: nope',
        nextTryAt: new Date(Date.now() - 1000),
      },
    })
    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ statusUrl: 'https://www.mybring.com/s/9/status/' }), { status: 202 }),
    ))

    expect(await requestNextReport(creds)).toBe(true)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-RETRY` } })
    expect(row?.state).toBe('REQUESTED')
    expect(row?.error).toBeNull()
  })

  // I1(b), the other half: without a backoff a permanently-broken invoice
  // would be retried every single tick forever, spending one of the tick's
  // few request slots on a hopeless row and — under oldest-first ordering,
  // since this row is backdated to look oldest — starving every invoice
  // behind it. nextTryAt in the future must keep it out of the selection
  // entirely, not merely deprioritise it.
  it('leaves a FAILED row alone until its backoff elapses, so a broken invoice does not spin every tick', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-BACKOFF`,
        invoiceDate: new Date('2020-01-01T00:00:00Z'), state: 'FAILED',
        error: 'boom',
        nextTryAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    expect(await requestNextReport(creds)).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })
})

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

  it('counts lines matched to a Shipment we hold apart from lines that are not', async () => {
    // KNOWN_WAYBILL carries 4 of the fixture's 6 lines; DUPLICATE_WAYBILL,
    // billed on the other 2, has no Shipment here. A distinct-waybill count
    // would say 1 matched / 1 unmatched; an inverted have.has() would say 2
    // matched / 4 unmatched. Only counting lines the right way round gives 4/2.
    await db.shipment.create({ data: { trackingNumber: KNOWN_WAYBILL } })
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-M`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    stubCollect(`${CUST}-M`)

    const result = await collectNextReport(creds)
    expect(result).toEqual({ stored: 6, unmatched: 2 })

    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-M` } })
    expect(row?.rowsStored).toBe(6)
    expect(row?.rowsUnmatched).toBe(2)
  })

  // I1(a): the same guard as requestNextReport, for the same reason —
  // reportStatus/downloadReport/listInvoices are Bring requests too, and past
  // the deadline requestBudgetMs would clamp each to a 1ms timeout that
  // aborts almost immediately, a throw the catch below cannot tell apart from
  // a genuine failure. Checked before the row is even read.
  it('does nothing once the deadline has passed, and does not touch the row', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-DL2`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    expect(await collectNextReport(creds, { deadline: Date.now() - 1 })).toBeNull()
    expect(fn).not.toHaveBeenCalled()
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-DL2` } })
    expect(row?.state).toBe('REQUESTED')
  })

  // I2: a REQUESTED row this old is not "not ready yet", it is stuck — either
  // parked NOT_DONE forever or answering a status shape this code no longer
  // recognises. Measured, the real report was DONE on the very first poll, so
  // STALE_REQUESTED_MS's many hours is a wide margin, not a tight guess. Aged
  // out to FAILED (I1(b)'s retry scheme) rather than left in place, because
  // requestedAt/statusUrl select oldest-first: a wedged row would otherwise
  // sit at the head of this queue and promote nothing behind it, forever.
  it('ages out a REQUESTED row that has sat far longer than a report ever legitimately takes', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-STALE`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
        requestedAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h ago
      },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    // Aged out without even asking Bring: a wedged status endpoint is exactly
    // what this guards against, so the fix cannot depend on calling it first.
    expect(await collectNextReport(creds)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-STALE` } })
    expect(row?.state).toBe('FAILED')
    expect(row?.nextTryAt).not.toBeNull()
  })

  // I4: a dropped line and a truncated download both make the lines fall
  // short of the header, and until now both produced the identical
  // reconciliation message — pointing at a truncated download even when the
  // real cause was one line missing WAYBILL_NUMBER, TRX_DATE or
  // INVOICE_CURRENCY_CODE. The skip count is what tells them apart.
  it('says how many lines were skipped when a report fails to reconcile because one line could not be read', async () => {
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-SKIP`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    const xmlUrl = 'https://www.mybring.com/s/1/report.xml'
    // Blanks exactly one of DUPLICATE_WAYBILL's two <Line> blocks (a plain,
    // non-global replace hits only the first) so parseSpecifiedInvoice drops
    // it for missing WAYBILL_NUMBER — one real line gone, not a truncated file.
    const broken = specifiedInvoiceXml
      .replace(/<InvoiceNumber>[^<]*<\/InvoiceNumber>/, `<InvoiceNumber>${CUST}-SKIP</InvoiceNumber>`)
      .replace('<WAYBILL_NUMBER>73325383643994654</WAYBILL_NUMBER>', '<WAYBILL_NUMBER></WAYBILL_NUMBER>')

    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async (u) => {
        const url = String(u)
        if (url.includes('/invoicearchive/api/invoices/')) {
          return new Response(JSON.stringify({
            invoices: [{ ...invoice(`${CUST}-SKIP`, true), amount: FIXTURE_TOTAL, totalAmount: FIXTURE_TOTAL }],
          }), { status: 200 })
        }
        if (url === xmlUrl) return new Response(broken, { status: 200 })
        return new Response(JSON.stringify({ status: 'DONE', xmlUrl }), { status: 200 })
      },
    ))

    await collectNextReport(creds)
    expect(await db.shipmentCost.count({ where: { invoiceNumber: `${CUST}-SKIP` } })).toBe(0)
    const row = await db.bringReportRun.findUnique({ where: { invoiceNumber: `${CUST}-SKIP` } })
    expect(row?.state).toBe('FAILED')
    expect(row?.error).toMatch(/reconcile/i)
    expect(row?.error).toMatch(/1 line/i)
  })
})

describe('syncBringInvoices', () => {
  // DeliveryConfig is a fixed-id singleton shared by the whole `delivery`
  // project (see the Global Constraints), so a test must never assume it
  // knows the row's starting state — another file may have left real
  // credentials on it, or none. Captured once here and restored exactly in
  // afterAll, via upsert-and-blank rather than delete, so a file running
  // beside this one (fileParallelism is off for this project, but the row
  // still must not vanish mid-suite) never finds the singleton missing.
  let originalBring: {
    bringApiUid: string | null
    bringApiKey: string | null
    bringClientUrl: string | null
  }

  beforeAll(async () => {
    const row = await db.deliveryConfig.findUnique({ where: { id: 'singleton' } })
    originalBring = {
      bringApiUid: row?.bringApiUid ?? null,
      bringApiKey: row?.bringApiKey ?? null,
      bringClientUrl: row?.bringClientUrl ?? null,
    }
  })

  afterAll(async () => {
    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...originalBring },
      update: originalBring,
    })
  })

  it('does nothing and says so when Bring is not connected', async () => {
    // Explicitly cleared, not assumed absent: this is a shared singleton and
    // another file in the `delivery` project may have left credentials on
    // it, which would make this test's result depend on run order.
    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: { bringApiUid: null, bringApiKey: null, bringClientUrl: null },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    const result = await syncBringInvoices()
    expect(result.configured).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('discovers, requests and collects at most one each per tick', async () => {
    // getDeliveryConfig() decrypts, so the key must be written encrypted,
    // exactly as the settings route stores it.
    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        bringApiUid: creds.uid,
        bringApiKey: encryptSecret(creds.key),
        bringClientUrl: creds.clientUrl,
      },
      update: {
        bringApiUid: creds.uid,
        bringApiKey: encryptSecret(creds.key),
        bringClientUrl: creds.clientUrl,
      },
    })
    // Proves the run cost is bounded: a hundred pending invoices must not make
    // one tick a hundred requests long.
    await db.bringReportRun.createMany({
      data: [1, 2, 3].map((n) => ({
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-T${n}`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'PENDING',
      })),
    })
    stubTick()
    const result = await syncBringInvoices()
    // The full shape, not just `configured` — this is the object the cron
    // route's JSON response is built from, and it is otherwise unchecked.
    expect(result).toEqual({
      configured: true,
      found: 0, queued: 0, noSpec: 0, partial: false,
      requested: true,
      stored: 0, unmatched: 0, costMonths: 0,
      error: null,
    })
    expect(await db.bringReportRun.count({ where: { ...mine, state: 'REQUESTED' } })).toBe(1)
  })

  // The field mapping at the end of syncBringInvoices assigns `stored` and
  // `unmatched` from collectNextReport's result by name. The tick test above
  // can't catch a swap between them because both are 0 there; this scenario
  // gives them different, non-zero values so a swap would fail the assertion.
  it('maps stored and unmatched to the right fields in the result, not swapped', async () => {
    await db.deliveryConfig.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        bringApiUid: creds.uid,
        bringApiKey: encryptSecret(creds.key),
        bringClientUrl: creds.clientUrl,
      },
      update: {
        bringApiUid: creds.uid,
        bringApiKey: encryptSecret(creds.key),
        bringClientUrl: creds.clientUrl,
      },
    })
    await db.shipment.create({ data: { trackingNumber: KNOWN_WAYBILL } })
    await db.bringReportRun.create({
      data: {
        customerNumber: `${CUST}1`, invoiceNumber: `${CUST}-MAP`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'), state: 'REQUESTED',
        statusUrl: 'https://www.mybring.com/s/1/status/',
      },
    })
    const xmlUrl = 'https://www.mybring.com/s/1/report.xml'
    const xml = specifiedInvoiceXml.replace(
      /<InvoiceNumber>[^<]*<\/InvoiceNumber>/,
      `<InvoiceNumber>${CUST}-MAP</InvoiceNumber>`,
    )
    vi.stubGlobal('fetch', vi.fn<(u: string | URL | Request, i?: RequestInit) => Promise<Response>>(
      async (u) => {
        const url = String(u)
        if (url.endsWith('/reports/api/generate')) {
          return new Response(JSON.stringify({ customer: [] }), { status: 200 })
        }
        if (url.includes('/invoicearchive/api/invoices/')) {
          return new Response(JSON.stringify({
            invoices: [{ ...invoice(`${CUST}-MAP`, true), amount: FIXTURE_TOTAL, totalAmount: FIXTURE_TOTAL }],
          }), { status: 200 })
        }
        if (url === xmlUrl) return new Response(xml, { status: 200 })
        return new Response(JSON.stringify({ status: 'DONE', xmlUrl }), { status: 200 })
      },
    ))

    const result = await syncBringInvoices()
    // 4 of the fixture's 6 lines match KNOWN_WAYBILL; the other 2, on
    // DUPLICATE_WAYBILL, match no Shipment here — see the matched-lines test
    // above `collectNextReport` for why that split is 4/2 and not 1/1 or 2/4.
    expect(result.stored).toBe(6)
    expect(result.unmatched).toBe(2)
  })
})

/**
 * Filling in what Bring billed, so nobody types it.
 *
 * The invoices are built in the WORKSPACE currency so no exchange rate is
 * involved and the arithmetic is exact - conversion has its own tests in
 * src/lib/delivery/invoiced-cost.test.ts. What is under test here is which
 * months get written and, above all, which rows are left alone.
 */
describe('writeBringCosts', () => {
  const CUR = async () => (await getSetting()).displayCurrency
  const invoice = (date: string, amountMinor: number, currency: string) => ({
    customerNumber: `${CUST}1`,
    invoiceNumber: `${CUST}-${date}`,
    invoiceDate: new Date(`${date}T00:00:00Z`),
    amountMinor,
    taxMinor: 0,
    totalMinor: amountMinor,
    currency,
    specificationAvailable: true,
  })
  const row = (month: string) =>
    db.carrierCost.findUnique({ where: { carrier_month: { carrier: 'BRING', month } } })

  it('adds a finished month up and writes it, so the box fills itself', async () => {
    const cur = await CUR()
    const written = await writeBringCosts(
      [invoice('1999-03-31', 100_00, cur), invoice('1999-03-15', 50_00, cur)],
      new Date('1999-05-01T00:00:00Z'),
    )

    expect(written).toBe(1)
    const march = await row('1999-03')
    expect(march?.amount).toBe(150_00)
    expect(march?.currency).toBe(cur)
    expect(march?.source).toBe('bring')
  })

  /**
   * A month still running has only some of its invoices in while its parcels
   * keep arriving, so the cost per parcel would read low and creep up all
   * month. A figure that moves under the reader is worse than one that lands a
   * few days late.
   */
  it('leaves the month that is still running alone', async () => {
    const cur = await CUR()
    const written = await writeBringCosts(
      [invoice('1999-05-10', 100_00, cur)],
      new Date('1999-05-20T00:00:00Z'),
    )

    expect(written).toBe(0)
    expect(await row('1999-05')).toBeNull()
  })

  /**
   * THE important one. A person who corrected a figure knows something the
   * archive does not - a credit note, a month split across two accounts - and
   * silently overwriting that on the next tick is the single behaviour that
   * would make this panel untrustworthy.
   */
  it('never overwrites a figure a person typed', async () => {
    const cur = await CUR()
    await db.carrierCost.create({
      data: { carrier: 'BRING', month: '1999-04', amount: 999_00, currency: cur, source: 'typed' },
    })

    const written = await writeBringCosts(
      [invoice('1999-04-30', 100_00, cur)],
      new Date('1999-06-01T00:00:00Z'),
    )

    expect(written).toBe(0)
    const april = await row('1999-04')
    expect(april?.amount).toBe(999_00)
    expect(april?.source).toBe('typed')
  })

  /** Its own earlier figure IS replaced: a re-issued invoice must land. */
  it('replaces a figure it wrote itself', async () => {
    const cur = await CUR()
    const when = new Date('1999-06-01T00:00:00Z')
    await writeBringCosts([invoice('1999-04-30', 100_00, cur)], when)
    await writeBringCosts(
      [invoice('1999-04-30', 100_00, cur), invoice('1999-04-15', 25_00, cur)],
      when,
    )

    const april = await row('1999-04')
    expect(april?.amount).toBe(125_00)
    expect(april?.source).toBe('bring')
  })

  /**
   * A bill from before parcel counting began is still a true bill, and the
   * client asked to SEE what was read. It is written and shown; whether it may
   * be DIVIDED is judged where the dividing happens, on the Delivery page,
   * which refuses months from before the record. The writer that both wrote
   * and deleted by a boundary left the card claiming automation with nothing
   * automatic visible on it.
   */
  it('writes a month from before parcel counting began, because the bill is true either way', async () => {
    const cur = await CUR()
    const written = await writeBringCosts(
      [invoice('1999-02-28', 100_00, cur)],
      new Date('1999-05-01T00:00:00Z'),
    )

    expect(written).toBe(1)
    expect((await row('1999-02'))?.amount).toBe(100_00)
  })

  it('leaves its own earlier rows standing, whatever month they are for', async () => {
    const cur = await CUR()
    await db.carrierCost.create({
      data: { carrier: 'BRING', month: '1999-02', amount: 999_00, currency: cur, source: 'bring' },
    })

    await writeBringCosts([invoice('1999-03-31', 100_00, cur)], new Date('1999-05-01T00:00:00Z'))

    expect((await row('1999-02'))?.amount).toBe(999_00)
  })

  it('writes nothing at all when there are no invoices', async () => {
    expect(await writeBringCosts([], new Date('1999-06-01T00:00:00Z'))).toBe(0)
  })
})
