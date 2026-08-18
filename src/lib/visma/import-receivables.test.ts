import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaReceivables } from './import'

const TAG = `TEST-AR-${Date.now()}`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const doc = (over: Record<string, unknown> = {}) => ({
  referenceNumber: `${TAG}-1`,
  customer: { number: '10920', name: 'Konfliktrådene' },
  documentType: 'Invoice',
  documentDate: '2025-12-17T00:00:00',
  documentDueDate: '2026-01-16T00:00:00',
  currencyId: 'NOK',
  amountInCurrency: 39999,
  balanceInCurrency: 39999,
  status: 'Open',
  ...over,
})

/** Routes the token call, then serves one response per page number. */
const stubPages = (pages: Record<number, { body: unknown; status?: number }>) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      const n = Number(new URL(u).searchParams.get('pageNumber') ?? '1')
      const p = pages[n] ?? { body: [] }
      return json(p.body, p.status ?? 200)
    }),
  )

beforeEach(() => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.receivable.deleteMany({ where: { referenceNumber: { startsWith: TAG } } })
})

describe('importVismaReceivables', () => {
  it('stores an open invoice we are actually owed', async () => {
    stubPages({ 1: { body: [doc()] } })

    const result = await importVismaReceivables()
    expect(result.error).toBeNull()
    expect(result.stored).toBe(1)

    const row = await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-1` } })
    expect(row).toMatchObject({
      customerName: 'Konfliktrådene',
      currency: 'NOK',
      balance: 3999900,
      documentType: 'Invoice',
    })
  })

  /**
   * The end-to-end form of the rule that makes this feature usable at all:
   * 994 of the first 1000 open documents are these house accounts.
   */
  it('leaves out the webshop collective accounts, and says how many', async () => {
    stubPages({
      1: {
        body: [
          doc({ referenceNumber: `${TAG}-web`, customer: { number: '1', name: 'Panetti Norge - Webkunde' } }),
          doc(),
        ],
      },
    })

    const result = await importVismaReceivables()

    expect(result.stored).toBe(1)
    expect(result.excluded).toBe(1)
    expect(await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-web` } })).toBeNull()
  })

  it('reads past the first page', async () => {
    const page1 = Array.from({ length: 1000 }, (_, n) =>
      doc({ referenceNumber: `${TAG}-a${n}`, customer: { number: '1', name: 'Panetti Norge - Webkunde' } }),
    )
    stubPages({ 1: { body: page1 }, 2: { body: [doc({ referenceNumber: `${TAG}-p2` })] } })

    const result = await importVismaReceivables()

    expect(result.partial).toBe(false)
    expect(await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-p2` } })).not.toBeNull()
  })

  /**
   * The constraint the whole importer is shaped around. A full page followed by
   * a refusal is a PARTIAL read: replacing the snapshot with it would delete
   * every invoice that lives on the pages we never got to see.
   */
  it('keeps the previous snapshot when a later page is refused', async () => {
    await db.receivable.create({
      data: {
        referenceNumber: `${TAG}-old`, customerNumber: '9', customerName: 'Earlier Reading',
        documentType: 'Invoice', documentDate: new Date('2026-01-01'), currency: 'NOK',
        amount: 100, balance: 100,
      },
    })
    const page1 = Array.from({ length: 1000 }, (_, n) =>
      doc({ referenceNumber: `${TAG}-b${n}`, customer: { number: '1', name: 'Panetti Norge - Webkunde' } }),
    )
    stubPages({ 1: { body: page1 }, 2: { body: { message: 'slow down' }, status: 429 } })

    const result = await importVismaReceivables()

    expect(result.partial).toBe(true)
    expect(await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-old` } })).not.toBeNull()
  })

  it('does not empty the table when the very first page is refused', async () => {
    await db.receivable.create({
      data: {
        referenceNumber: `${TAG}-keep`, customerNumber: '9', customerName: 'Earlier Reading',
        documentType: 'Invoice', documentDate: new Date('2026-01-01'), currency: 'NOK',
        amount: 100, balance: 100,
      },
    })
    stubPages({ 1: { body: { message: 'slow down' }, status: 429 } })

    const result = await importVismaReceivables()

    expect(result.partial).toBe(true)
    expect(result.stored).toBe(0)
    expect(await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-keep` } })).not.toBeNull()
  })

  /** A paid invoice must stop appearing, which a snapshot gives us for free. */
  it('drops an invoice that has since been paid', async () => {
    stubPages({ 1: { body: [doc(), doc({ referenceNumber: `${TAG}-paid` })] } })
    await importVismaReceivables()
    stubPages({ 1: { body: [doc()] } })
    await importVismaReceivables()

    expect(await db.receivable.findUnique({ where: { referenceNumber: `${TAG}-paid` } })).toBeNull()
  })

  it('is quietly skipped when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_SECRET', '')

    const result = await importVismaReceivables()

    expect(result.configured).toBe(false)
    expect(result.error).toBeNull()
  })

  it('reports a refusal instead of throwing, so the rest of the sync survives', async () => {
    stubPages({ 1: { body: { message: 'boom' }, status: 500 } })

    const result = await importVismaReceivables()

    expect(result.error).toMatch(/500/)
    expect(result.stored).toBe(0)
  })
})
