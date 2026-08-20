import { describe, expect, it, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { discoverInvoices } from './invoice-sync'

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
