import { describe, expect, it, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { discoverInvoices, requestNextReport } from './invoice-sync'

// Unique to THIS file — see "Test data convention" in the Global Constraints.
const CUST = 'ZZDISC'
const mine = { customerNumber: { startsWith: CUST } }
const creds = { uid: 'u', key: 'k', clientUrl: 'https://panetti.vercel.app' }

// Deletes from BOTH tables this file (and Tasks 6/7's later additions to it)
// can write. ShipmentCost has no customerNumber prefix of its own to scope
// by, but every invoiceNumber this file creates starts with CUST, so scoping
// there keeps a future test's rows from leaking into the shared database.
const cleanup = async () => {
  await db.bringReportRun.deleteMany({ where: mine })
  await db.shipmentCost.deleteMany({ where: { invoiceNumber: { startsWith: CUST } } })
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
