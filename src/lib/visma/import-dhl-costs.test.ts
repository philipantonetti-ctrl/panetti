import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { getSetting } from '../settings'
import { resetVismaTokenCache } from './client'
import { importVismaDhlCosts } from './import'

/**
 * DHL's monthly freight bill, read from the company's own accounting.
 *
 * DHL offers no invoice API for these parcels, and the client asked for
 * automatic. But every DHL invoice gets paid, and paid invoices are booked in
 * Visma - measured 2026-08-21: supplier 50606 "DHL Freight (sweden) AB" holds
 * 66 invoices, February through August, e.g. July = 23 455 SEK. So the number
 * the card wants a person to type is already sitting in a system we read.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const invoice = (over: Record<string, unknown> = {}) => ({
  referenceNumber: '205717',
  supplier: { number: '50606', name: 'DHL Freight (sweden) AB' },
  documentType: 'Invoice',
  date: '1999-07-14T00:00:00',
  currencyId: 'SEK',
  detailTotalInCurrency: 399,
  ...over,
})

const stub = (rows: unknown[]) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      return json(rows)
    }),
  )

/**
 * Invoices are built in the WORKSPACE currency, whatever this database's
 * happens to be, so conversion is the identity and no exchange rate is
 * involved - the currency conversion has its own tests in
 * src/lib/delivery/invoiced-cost.test.ts. What is under test here is the
 * read, the guard and the write.
 */
const CUR = async () => (await getSetting()).displayCurrency

const NOW = new Date('1999-08-21T12:00:00Z')

beforeEach(async () => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
  await db.carrierCost.deleteMany({ where: { carrier: 'DHL', month: { startsWith: '1999-0' } } })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.carrierCost.deleteMany({ where: { carrier: 'DHL', month: { startsWith: '1999-0' } } })
})

const row = () =>
  db.carrierCost.findUnique({ where: { carrier_month: { carrier: 'DHL', month: '1999-07' } } })

describe('importVismaDhlCosts', () => {
  it('reports not configured without credentials, and calls nothing', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)

    const result = await importVismaDhlCosts(NOW)
    expect(result.configured).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('adds a finished month of DHL invoices up and writes it, marked visma', async () => {
    const cur = await CUR()
    stub([
      invoice({ referenceNumber: '205717', detailTotalInCurrency: 20_000, currencyId: cur }),
      invoice({ referenceNumber: '205718', detailTotalInCurrency: 3_455, currencyId: cur }),
    ])

    const result = await importVismaDhlCosts(NOW)
    expect(result.error).toBeNull()
    expect(result.written).toBe(1)

    const july = await row()
    expect(july?.amount).toBe(23_455_00)
    expect(july?.source).toBe('visma')
  })

  it('leaves the month that is still running alone', async () => {
    const cur = await CUR()
    stub([invoice({ date: '1999-08-14T00:00:00', currencyId: cur })])

    const result = await importVismaDhlCosts(NOW)
    expect(result.written).toBe(0)
    expect(
      await db.carrierCost.findUnique({
        where: { carrier_month: { carrier: 'DHL', month: '1999-08' } },
      }),
    ).toBeNull()
  })

  it('never overwrites a figure a person typed', async () => {
    await db.carrierCost.create({
      data: { carrier: 'DHL', month: '1999-07', amount: 999_00, currency: 'SEK', source: 'typed' },
    })
    stub([invoice({ currencyId: await CUR() })])

    await importVismaDhlCosts(NOW)
    const july = await row()
    expect(july?.amount).toBe(999_00)
    expect(july?.source).toBe('typed')
  })

  /**
   * THE trap this API is known for: an unknown query parameter returns
   * HTTP 200 with the WRONG rows - customerNumber= once served Kitch'n's
   * invoices. If the supplier filter is ever ignored, this import would sum
   * the company's entire purchase ledger into "DHL". A single foreign row is
   * treated as proof the filter failed, and nothing is written.
   */
  it('refuses the whole read when any row belongs to another supplier', async () => {
    stub([
      invoice(),
      invoice({ referenceNumber: 'X1', supplier: { number: '50264', name: 'Bring Parcels AB (Ny)' } }),
    ])

    const result = await importVismaDhlCosts(NOW)
    expect(result.written).toBe(0)
    expect(result.error).toMatch(/filter/i)
    expect(await row()).toBeNull()
  })

  it('stores the failure rather than throwing when Visma is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
        return new Response('boom', { status: 500 })
      }),
    )

    const result = await importVismaDhlCosts(NOW)
    expect(result.error).toMatch(/500/)
    expect(result.written).toBe(0)
  })
})
