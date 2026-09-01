import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const getToken = vi.fn()
const listSettlements = vi.fn()
const downloadReport = vi.fn()
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  getToken: (...a: unknown[]) => getToken(...a),
  listSettlements: (...a: unknown[]) => listSettlements(...a),
  downloadReport: (...a: unknown[]) => downloadReport(...a),
}))

const { db } = await import('@/lib/db')
const { encryptSecret } = await import('@/lib/secrets')
const { syncDinteroPayouts } = await import('./sync')

const MARK = 'dintero-sync-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.payout.deleteMany({ where: { shopId: { in: ids } } })
  await db.dinteroConfig.deleteMany({ where: { shopId: { in: ids } } })
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  getToken.mockReset().mockResolvedValue('tok')
  listSettlements.mockReset()
  downloadReport.mockReset()
})

async function shopWithConfig(over: Record<string, unknown> = {}) {
  const shop = await db.shop.create({ data: { name: `${MARK} NO`, currency: 'NOK' } })
  await db.dinteroConfig.create({
    data: {
      shopId: shop.id,
      accountId: 'P12345678',
      clientId: encryptSecret('cid'),
      clientSecret: encryptSecret('sec'),
      ...over,
    },
  })
  return shop
}

const orderData = (shopId: string, number: string, externalId = `w-${number}`) => ({
  shopId,
  externalId,
  number,
  placedAt: new Date('2026-08-18T10:00:00Z'),
  status: 'completed',
  currency: 'NOK',
  grossSales: 5000,
  discountTotal: 0,
  netSales: 5000,
  shippingCharged: 0,
  taxTotal: 1250,
  total: 6250,
})

const settlement = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: 'dintero_payout',
  settledAt: new Date('2026-08-28T09:00:00Z'),
  periodStart: new Date('2026-08-17T00:00:00Z'),
  periodEnd: new Date('2026-08-23T23:59:59Z'),
  currency: 'NOK',
  amount: 9800,
  capture: 10000,
  refund: 0,
  fee: 200,
  payoutDestinationId: null,
  attachments: [{ id: 'a-json', extension: 'json', contentType: 'application/json', createdBy: 'dintero' }],
  ...over,
})

describe('syncDinteroPayouts', () => {
  it('reports not configured, and asks Dintero nothing, when no shop is connected', async () => {
    // Scoped to a shop that has no connection: the suite's other files
    // connect their own shops in the same database, in parallel.
    const result = await syncDinteroPayouts({ shopId: 'no-such-shop' })
    expect(result.configured).toBe(false)
    expect(getToken).not.toHaveBeenCalled()
  })

  it('mirrors the payout, stores its report lines and matches them to orders', async () => {
    const shop = await shopWithConfig()
    await db.order.create({ data: orderData(shop.id, '3041') })
    // Matched by Woo order id when the reference is not the number.
    await db.order.create({ data: orderData(shop.id, '2988', 'woo-77') })

    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: 'DINTERO-42',
      fileUrl: 'https://storage.dintero.example/reports/s1.json?sig=abc',
      lines: [
        { transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: new Date('2026-08-18'), paymentType: 'dintero_payout.creditcard', cardBrand: 'Visa' },
        { transactionId: 't2', reference: 'woo-77', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: new Date('2026-08-19'), paymentType: 'dintero_payout.creditcard', cardBrand: null },
        // Nobody wears this number: it stays unmatched, and the page says so.
        { transactionId: 't3', reference: '9999', amount: 0, capture: 0, refund: 0, fee: 0, transactionDate: null, paymentType: null, cardBrand: null },
      ],
    })

    const result = await syncDinteroPayouts({ shopId: shop.id })

    expect(result).toMatchObject({ configured: true, ok: true, payouts: 1, lines: 3, matched: 2, unmatched: 1 })

    const payout = await db.payout.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: 's1' } },
      include: { lines: { orderBy: { transactionId: 'asc' }, include: { order: true } } },
    })
    expect(payout).toMatchObject({ currency: 'NOK', amount: 9800, capture: 10000, fee: 200, reference: 'DINTERO-42', linesPending: false })
    expect(payout.settledAt).toEqual(new Date('2026-08-28T09:00:00Z'))
    expect(payout.lines[0].order?.number).toBe('3041')
    expect(payout.lines[1].order?.number).toBe('2988')
    expect(payout.lines[2].orderId).toBeNull()

    const cfg = await db.dinteroConfig.findUniqueOrThrow({ where: { shopId: shop.id } })
    expect(cfg.lastSyncAt).not.toBeNull()
    expect(cfg.lastError).toBeNull()
    expect(cfg.lastReportUrl).toBe('https://storage.dintero.example/reports/s1.json?sig=abc')
  })

  it('skips a fresh connection and syncs it again after six hours, or when forced', async () => {
    const shop = await shopWithConfig({ lastSyncAt: new Date(Date.now() - 60_000) })
    expect((await syncDinteroPayouts({ shopId: shop.id })).skippedFresh).toBe(true)
    expect(listSettlements).not.toHaveBeenCalled()

    listSettlements.mockResolvedValue([])
    expect((await syncDinteroPayouts({ force: true, shopId: shop.id })).skippedFresh).toBeUndefined()
    expect(listSettlements).toHaveBeenCalled()
  })

  it('matches an order that arrived after the report, without downloading it again', async () => {
    const shop = await shopWithConfig()
    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: null,
      lines: [{ transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: null, paymentType: null, cardBrand: null }],
    })
    expect((await syncDinteroPayouts({ force: true, shopId: shop.id })).unmatched).toBe(1)

    // The order syncs in later - the next run picks it up from our own rows.
    await db.order.create({ data: orderData(shop.id, '3041') })
    const second = await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(second.matched).toBe(1)
    expect(downloadReport).toHaveBeenCalledTimes(1)
    const line = await db.payoutLine.findFirstOrThrow({
      where: { reference: '3041', payout: { shopId: shop.id } },
      include: { order: true },
    })
    expect(line.order?.number).toBe('3041')
  })

  it('never matches an order from another shop wearing the same number', async () => {
    const shop = await shopWithConfig()
    const other = await db.shop.create({ data: { name: `${MARK} SE`, currency: 'SEK' } })
    await db.order.create({ data: orderData(other.id, '3041') })

    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: null,
      lines: [{ transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: null, paymentType: null, cardBrand: null }],
    })

    const result = await syncDinteroPayouts({ force: true, shopId: shop.id })
    expect(result.matched).toBe(0)
    expect(result.unmatched).toBe(1)
    expect(shop.id).not.toBe(other.id)
  })

  it('retries the report for a payout stored empty before the link envelope was understood', async () => {
    const shop = await shopWithConfig()
    // The broken state the first release left behind: report "processed",
    // yet no lines and no reference - the envelope was mistaken for the file.
    await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', currency: 'NOK',
        amount: 9800, capture: 10000, refund: 0, fee: 200,
        linesPending: false, reference: null,
      },
    })
    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: 'DINTERO-42',
      lines: [{ transactionId: 't1', reference: '3041', amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: null, paymentType: null, cardBrand: null }],
    })

    const result = await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(result.lines).toBe(1)
    const payout = await db.payout.findUniqueOrThrow({
      where: { shopId_externalId: { shopId: shop.id, externalId: 's1' } },
    })
    expect(payout.reference).toBe('DINTERO-42')
    expect(payout.linesPending).toBe(false)
  })

  it('leaves a report alone once the current parser has read it', async () => {
    const shop = await shopWithConfig()
    await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', currency: 'NOK',
        amount: 0, capture: 0, refund: 0, fee: 0,
        linesPending: false, reference: 'REF-KEPT', reportVersion: 2,
      },
    })
    listSettlements.mockResolvedValue([settlement('s1')])

    await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(downloadReport).not.toHaveBeenCalled()
  })

  it('re-ingests a report read by an older parser, even one that stored lines', async () => {
    const shop = await shopWithConfig()
    const payout = await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', currency: 'NOK',
        amount: 9800, capture: 10000, refund: 0, fee: 200,
        linesPending: false, reference: 'OLD-REF', reportVersion: 0,
        lines: { create: { transactionId: 't-old', reference: 'dwc1.1', amount: 0, capture: 10000, refund: 0, fee: 200 } },
      },
    })
    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: 'DINTERO-42',
      lines: [{ transactionId: 't1', reference: 'dwc1.1', reference2: '3041', amount: 9800, capture: 10000, refund: 0, fee: 200, transactionDate: null, paymentType: null, cardBrand: null }],
    })

    await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(downloadReport).toHaveBeenCalledTimes(1)
    const after = await db.payout.findUniqueOrThrow({ where: { id: payout.id }, include: { lines: true } })
    expect(after.reportVersion).toBeGreaterThanOrEqual(2)
    expect(after.reference).toBe('DINTERO-42')
    expect(after.lines).toHaveLength(1)
    expect(after.lines[0].reference2).toBe('3041')
  })

  it('matches by the order number Dintero keeps in merchant_reference_2', async () => {
    const shop = await shopWithConfig()
    await db.order.create({ data: orderData(shop.id, '3041') })
    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({
      reference: 'DINTERO-42',
      lines: [{
        // The WooCommerce plugin's real shape: a generated merchant_reference,
        // the order number one field over.
        transactionId: 't1', reference: 'dwc6a8ea49994f8f8.21480369', reference2: '3041',
        amount: 4900, capture: 5000, refund: 0, fee: 100, transactionDate: null, paymentType: null, cardBrand: null,
      }],
    })

    const result = await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(result.matched).toBe(1)
    const line = await db.payoutLine.findFirstOrThrow({
      where: { reference2: '3041', payout: { shopId: shop.id } },
      include: { order: true },
    })
    expect(line.order?.number).toBe('3041')
  })

  it('a backlog of unread reports makes even a fresh connection due', async () => {
    const shop = await shopWithConfig({ lastSyncAt: new Date(Date.now() - 45 * 60_000) })
    await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', currency: 'NOK',
        amount: 9800, capture: 10000, refund: 0, fee: 200, linesPending: true,
      },
    })
    listSettlements.mockResolvedValue([settlement('s1')])
    downloadReport.mockResolvedValue({ reference: 'DINTERO-42', lines: [] })

    const result = await syncDinteroPayouts({ shopId: shop.id })

    expect(result.skippedFresh).toBeUndefined()
    expect(downloadReport).toHaveBeenCalledTimes(1)
  })

  it('a backlog inside the last half hour still waits its turn', async () => {
    const shop = await shopWithConfig({ lastSyncAt: new Date(Date.now() - 60_000) })
    await db.payout.create({
      data: {
        shopId: shop.id, externalId: 's1', currency: 'NOK',
        amount: 9800, capture: 10000, refund: 0, fee: 200, linesPending: true,
      },
    })

    const result = await syncDinteroPayouts({ shopId: shop.id })

    expect(result.skippedFresh).toBe(true)
    expect(listSettlements).not.toHaveBeenCalled()
  })

  it('stores the provider error on the connection and keeps the old payouts', async () => {
    const shop = await shopWithConfig()
    await db.payout.create({
      data: { shopId: shop.id, externalId: 'kept', currency: 'NOK', amount: 1, capture: 1, refund: 0, fee: 0 },
    })
    const { DinteroApiError } = await import('./client')
    getToken.mockRejectedValue(new DinteroApiError('Dintero answered 500. Try again in a while.'))

    const result = await syncDinteroPayouts({ force: true, shopId: shop.id })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/500/)
    expect((await db.dinteroConfig.findUniqueOrThrow({ where: { shopId: shop.id } })).lastError).toMatch(/500/)
    expect(await db.payout.count({ where: { shopId: shop.id } })).toBe(1)
  })

  it('leaves connections untouched when the run is out of time', async () => {
    const shop = await shopWithConfig()
    const result = await syncDinteroPayouts({ force: true, deadline: Date.now() - 1, shopId: shop.id })
    expect(result.ok).toBe(true)
    expect(getToken).not.toHaveBeenCalled()
    expect((await db.dinteroConfig.findFirstOrThrow({ where: { shopId: shop.id } })).lastSyncAt).toBeNull()
  })
})
