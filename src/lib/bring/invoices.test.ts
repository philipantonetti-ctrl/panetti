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

  it('skips null elements in the customer array', async () => {
    stub(200, JSON.stringify({ customer: [{ id: 'A' }, null, { id: 'B' }] }))
    expect(await listCustomerNumbers(creds)).toEqual(['A', 'B'])
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

  /**
   * This message is shown to the client on the Delivery page, so the markup
   * has to come out of it here rather than be tidied where it is read.
   *
   * Verbatim from Bring on 2026-08-21. Truncating instead kept the XML
   * declaration and dropped the two words that mattered, which is exactly the
   * failure src/lib/error-body.ts was written for after a client read
   * "WooCommerce responded 500: <!DOCTYPE html>" off his own dashboard.
   */
  it('says what Bring said, not the XML it wrapped it in', async () => {
    stub(406, `${XML_ERROR}`)
    await expect(listInvoices(creds, '20020467369')).rejects.toThrow(
      'Bring responded 406: Not Acceptable',
    )
  })
})

/** Bring's real 406 body, copied from a live response on 2026-08-21. */
const XML_ERROR = "<?xml version='1.0' encoding='UTF-8'?><String>Not Acceptable</String>"

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
