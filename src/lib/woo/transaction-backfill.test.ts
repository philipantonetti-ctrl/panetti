import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchOrdersByIds = vi.fn()
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  fetchOrdersByIds: (...a: unknown[]) => fetchOrdersByIds(...a),
}))

const { db } = await import('@/lib/db')
const { backfillOrderTransactionIds } = await import('./transaction-backfill')

const MARK = 'tx-backfill-test'

async function cleanup() {
  const shops = await db.shop.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } })
  const ids = shops.map((s) => s.id)
  await db.order.deleteMany({ where: { shopId: { in: ids } } })
  await db.shop.deleteMany({ where: { id: { in: ids } } })
}
afterAll(cleanup)
beforeEach(async () => {
  await cleanup()
  fetchOrdersByIds.mockReset()
})

const orderData = (shopId: string, externalId: string, transactionId: string | null = null) => ({
  shopId,
  externalId,
  number: externalId,
  transactionId,
  placedAt: new Date('2026-08-18T10:00:00Z'),
  status: 'completed',
  currency: 'SEK',
  grossSales: 5000,
  discountTotal: 0,
  netSales: 5000,
  shippingCharged: 0,
  taxTotal: 1250,
  total: 6250,
})

describe('backfillOrderTransactionIds', () => {
  it('revisits an order stamped before the dwc reference column existed', async () => {
    const shop = await db.shop.create({
      data: { name: `${MARK} revisit`, currency: 'SEK', wooUrl: 'https://x.test', wooKey: 'k', wooSecret: 's' },
    })
    // Stamped by the first backfill: transactionId checked, dwc column new.
    await db.order.create({ data: { ...orderData(shop.id, '11536', ''), dinteroReference: null } })
    fetchOrdersByIds.mockResolvedValue([
      {
        id: 11536,
        transaction_id: '',
        meta_data: [
          { key: '_dintero_merchant_reference', value: 'dwc69f647252c3054.1' },
          { key: '_dintero_transaction_id', value: 'P1.meta' },
        ],
      },
    ])

    const result = await backfillOrderTransactionIds({ shopIds: [shop.id] })

    expect(result.checked).toBe(1)
    const row = await db.order.findFirstOrThrow({ where: { shopId: shop.id } })
    expect(row.dinteroReference).toBe('dwc69f647252c3054.1')
    // The meta transaction id fills in what the core field never held.
    expect(row.transactionId).toBe('P1.meta')
  })

  it('fills the transaction id from the store, and marks the rest as checked', async () => {
    const shop = await db.shop.create({
      data: { name: `${MARK} SE`, currency: 'SEK', wooUrl: 'https://x.test', wooKey: 'k', wooSecret: 's' },
    })
    // Distinct placedAt: the walk is newest-first, and the assertion below
    // reads the request order.
    await db.order.create({ data: { ...orderData(shop.id, '13894'), placedAt: new Date('2026-08-18T11:00:00Z') } })
    // Woo holds no id for it.
    await db.order.create({ data: { ...orderData(shop.id, '13895'), placedAt: new Date('2026-08-18T10:30:00Z') } })
    await db.order.create({ data: orderData(shop.id, '13896', 'already-set') })

    fetchOrdersByIds.mockResolvedValue([
      { id: 13894, transaction_id: 'P11114428.5Gooe6v4sQE1VE1VxCGY8m' },
      { id: 13895, transaction_id: '' },
    ])

    const result = await backfillOrderTransactionIds({ shopIds: [shop.id] })

    // All three go: the dwc column is new, so even the stamped one is
    // revisited once for it - and keeps its id when the store omits it.
    expect(result.checked).toBe(3)
    expect(result.filled).toBe(1)
    expect(result.errors).toEqual([])
    expect(fetchOrdersByIds.mock.calls[0][1]).toEqual(['13894', '13895', '13896'])

    const rows = await db.order.findMany({ where: { shopId: shop.id }, orderBy: { externalId: 'asc' } })
    expect(rows.map((r) => r.transactionId)).toEqual(['P11114428.5Gooe6v4sQE1VE1VxCGY8m', '', 'already-set'])
    expect(rows.map((r) => r.dinteroReference)).toEqual(['', '', ''])
  })

  it('marks an order the store no longer returns as checked, so it is never asked again', async () => {
    const shop = await db.shop.create({
      data: { name: `${MARK} gone`, currency: 'SEK', wooUrl: 'https://x.test', wooKey: 'k', wooSecret: 's' },
    })
    await db.order.create({ data: orderData(shop.id, '7001') })
    fetchOrdersByIds.mockResolvedValue([]) // deleted on the store

    await backfillOrderTransactionIds({ shopIds: [shop.id] })

    const row = await db.order.findFirstOrThrow({ where: { shopId: shop.id } })
    expect(row.transactionId).toBe('')
  })

  it('stops at the deadline and leaves the rest for the next run', async () => {
    const shop = await db.shop.create({
      data: { name: `${MARK} slow`, currency: 'SEK', wooUrl: 'https://x.test', wooKey: 'k', wooSecret: 's' },
    })
    await db.order.create({ data: orderData(shop.id, '8001') })

    const result = await backfillOrderTransactionIds({ shopIds: [shop.id], deadline: Date.now() - 1 })

    expect(result.checked).toBe(0)
    expect(fetchOrdersByIds).not.toHaveBeenCalled()
    expect((await db.order.findFirstOrThrow({ where: { shopId: shop.id } })).transactionId).toBeNull()
  })

  it('a shop with unmatched payout lines goes first, whatever its name', async () => {
    // Alphabetically "aaa" would win - but "zzz" is the shop someone is
    // staring at an orange line on, so it gets the budget first.
    const plain = await db.shop.create({
      data: { name: `${MARK} aaa`, currency: 'NOK', wooUrl: 'https://a.test', wooKey: 'k', wooSecret: 's' },
    })
    const hurting = await db.shop.create({
      data: { name: `${MARK} zzz`, currency: 'SEK', wooUrl: 'https://z.test', wooKey: 'k', wooSecret: 's' },
    })
    await db.order.create({ data: orderData(plain.id, '1') })
    await db.order.create({ data: orderData(hurting.id, '2') })
    await db.payout.create({
      data: {
        shopId: hurting.id, externalId: 'p1', currency: 'SEK', amount: 1, capture: 1, refund: 0, fee: 0,
        linesPending: false, reportVersion: 3,
        lines: { create: { transactionId: 'tx-open', reference: 'dwc1', amount: 1, capture: 1, refund: 0, fee: 0 } },
      },
    })
    fetchOrdersByIds.mockResolvedValue([])

    await backfillOrderTransactionIds({ shopIds: [plain.id, hurting.id] })

    expect(fetchOrdersByIds.mock.calls[0][0]).toMatchObject({ url: 'https://z.test' })
  })

  it('a store that fails keeps its error and costs nobody else their turn', async () => {
    const bad = await db.shop.create({
      data: { name: `${MARK} bad`, currency: 'SEK', wooUrl: 'https://x.test', wooKey: 'k', wooSecret: 's' },
    })
    const good = await db.shop.create({
      data: { name: `${MARK} good`, currency: 'NOK', wooUrl: 'https://y.test', wooKey: 'k', wooSecret: 's' },
    })
    await db.order.create({ data: orderData(bad.id, '1') })
    await db.order.create({ data: orderData(good.id, '2') })
    fetchOrdersByIds
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ id: 2, transaction_id: 'P1.x' }])

    const result = await backfillOrderTransactionIds({ shopIds: [bad.id, good.id] })

    expect(result.errors).toHaveLength(1)
    expect(result.filled).toBe(1)
    expect((await db.order.findFirstOrThrow({ where: { shopId: good.id } })).transactionId).toBe('P1.x')
  })
})
