import { describe, expect, it } from 'vitest'
import orderFixtures from './__fixtures__/purchase-orders.json'
import receiptFixtures from './__fixtures__/purchase-receipts.json'
import {
  mapVismaOrders,
  receiptDatesByNumber,
  unwrap,
  type VismaOrder,
  type VismaReceipt,
} from './purchase-orders'

const FIXTURES = orderFixtures as unknown as VismaOrder[]
const RECEIPTS = receiptFixtures as unknown as VismaReceipt[]
const byNbr = (n: string) => FIXTURES.find((o) => String(unwrap(o.orderNbr)) === n)!

const OURS = new Set(['PANPIZPRO', 'PANPRIMIXPRO', 'MACBL661', 'MACBE661', 'MLCBL510', 'MLCBE51'])
const DATES = receiptDatesByNumber(RECEIPTS)

// The fixtures hold BARE scalars, recorded unwrapped. These builders use the
// WRAPPED form, so both branches of unwrap are exercised by the suite.
const order = (over: Partial<VismaOrder> = {}): VismaOrder => ({
  orderNbr: '500001',
  status: { value: 'Open' },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  purchaseReceipts: [],
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: 'PANPIZPRO' } },
      orderQty: { value: 800 },
      qtyOnReceipts: { value: 300 },
      promised: { value: '2026-08-20' },
      completed: { value: false },
      canceled: false,
    },
  ],
  ...over,
})

describe('unwrap', () => {
  it('reads both the wrapped and the bare form, because Visma sends both', () => {
    expect(unwrap<number>({ value: 7 })).toBe(7)
    expect(unwrap<number>(7)).toBe(7)
    expect(unwrap<string>(null)).toBeNull()
    expect(unwrap<string>(undefined)).toBeNull()
    expect(unwrap<string>({ value: null })).toBeNull()
  })
})

describe('receiptDatesByNumber', () => {
  it('indexes the recorded receipts by their number', () => {
    expect(DATES.size).toBe(RECEIPTS.length)
    for (const [nbr, d] of DATES) {
      expect(typeof nbr).toBe('string')
      expect(d).toBeInstanceOf(Date)
    }
  })

  it('ignores a receipt with no number or no date', () => {
    const map = receiptDatesByNumber([
      { receiptNbr: { value: '' }, date: { value: '2026-01-01' } },
      { receiptNbr: { value: 'X' }, date: null },
    ] as VismaReceipt[])
    expect(map.size).toBe(0)
  })
})

describe('mapVismaOrders', () => {
  it('keeps ordered and received as two separate numbers', () => {
    const { orders } = mapVismaOrders([order()], OURS, DATES)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      externalId: '500001-1',
      sku: 'PANPIZPRO',
      quantity: 800,
      receivedQuantity: 300,
    })
  })

  it('prefers the line promise over the order promise', () => {
    expect(mapVismaOrders([order()], OURS, DATES).orders[0].eta).toEqual(
      new Date('2026-08-20T00:00:00Z'),
    )
  })

  it('falls back to the order promise when the line has none', () => {
    const o = order()
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS, DATES).orders[0].eta).toEqual(new Date('2026-09-01T00:00:00Z'))
  })

  it('leaves eta null when nobody promised anything, so it moves no date', () => {
    const o = order({ promisedOn: null })
    o.lines![0].promised = null
    expect(mapVismaOrders([o], OURS, DATES).orders[0].eta).toBeNull()
  })

  it('does not mark an incomplete line received, whatever the quantities say', () => {
    expect(mapVismaOrders([order()], OURS, DATES).orders[0].receivedAt).toBeNull()
  })

  it('marks a completed line received even though quantities disagree', () => {
    // This is the whole point. Visma closes orders without booking receipts.
    const o = order()
    o.lines![0].completed = { value: true }
    expect(mapVismaOrders([o], OURS, DATES).orders[0].receivedAt).not.toBeNull()
  })

  it('skips a cancelled order and counts every one of its lines', () => {
    const { orders, skipped } = mapVismaOrders(
      [order({ status: { value: 'Cancelled' } })],
      OURS,
      DATES,
    )
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'cancelled order', count: 1 })
  })

  it('skips an order on hold, because nobody has actually placed it', () => {
    const { orders, skipped } = mapVismaOrders([order({ status: { value: 'Hold' } })], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'order on hold', count: 1 })
  })

  it('skips an order flagged hold even when its status does not say so', () => {
    expect(mapVismaOrders([order({ hold: { value: true } })], OURS, DATES).orders).toHaveLength(0)
  })

  it('skips a cancelled line but keeps its siblings', () => {
    const o = order()
    o.lines!.push({
      lineNbr: 2,
      inventory: { number: { value: 'PANPRIMIXPRO' } },
      orderQty: { value: 100 },
      qtyOnReceipts: { value: 0 },
      completed: { value: true },
      canceled: { value: true },
    })
    const { orders, skipped } = mapVismaOrders([o], OURS, DATES)
    expect(orders.map((r) => r.sku)).toEqual(['PANPIZPRO'])
    expect(skipped).toContainEqual({ reason: 'cancelled line', count: 1 })
  })

  it('skips a product that is not ours, and says so rather than going quiet', () => {
    const o = order()
    o.lines![0].inventory = { number: { value: 'COSORI-AF-500' } }
    const { orders, skipped, read } = mapVismaOrders([o], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(read).toBe(1)
    expect(skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('matches a SKU case-insensitively and ignores surrounding space', () => {
    const o = order()
    o.lines![0].inventory = { number: '  panpizpro ' }
    expect(mapVismaOrders([o], OURS, DATES).orders[0].sku).toBe('PANPIZPRO')
  })

  it('skips a line with no product or no quantity rather than storing a zero-unit order', () => {
    const o = order()
    o.lines = [{ lineNbr: 1, inventory: { number: { value: 'PANPIZPRO' } }, orderQty: { value: 0 } }]
    const { orders, skipped } = mapVismaOrders([o], OURS, DATES)
    expect(orders).toHaveLength(0)
    expect(skipped).toContainEqual({ reason: 'unusable line', count: 1 })
  })

  it('skips an order with no usable date rather than inventing one', () => {
    expect(mapVismaOrders([order({ date: null })], OURS, DATES).orders).toHaveLength(0)
  })

  it('never stores a negative received quantity', () => {
    const o = order()
    o.lines![0].qtyOnReceipts = { value: -5 }
    expect(mapVismaOrders([o], OURS, DATES).orders[0].receivedQuantity).toBe(0)
  })
})

// The recorded company data. These are the cases that decided the design.
describe('mapVismaOrders, against the recorded orders', () => {
  it('order 500148 is NOT incoming, though it has zero receipts', () => {
    // Closed, completed:true, qtyOnReceipts:0, no receipt anywhere. A
    // quantity-based test reads this as 47 units arriving in 2024, forever.
    const rows = mapVismaOrders([byNbr('500148')], OURS, DATES).orders
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.receivedAt).not.toBeNull()
      expect(r.receivedQuantity).toBe(0)
    }
  })

  it('order 500259 is a real open order for a Panetti product', () => {
    const rows = mapVismaOrders([byNbr('500259')], OURS, DATES).orders
    const pizza = rows.find((r) => r.sku === 'PANPIZPRO')
    expect(pizza).toBeDefined()
    expect(pizza!.quantity).toBe(3055)
    expect(pizza!.receivedQuantity).toBe(0)
    expect(pizza!.receivedAt).toBeNull() // still coming
  })

  it('order 500254 contributes its open lines and nothing else', () => {
    const rows = mapVismaOrders([byNbr('500254')], OURS, DATES).orders
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.receivedAt).toBeNull()
  })

  it('the cancelled and held orders contribute nothing', () => {
    const { orders, skipped } = mapVismaOrders([byNbr('500000'), byNbr('500235')], OURS, DATES)
    expect(orders).toHaveLength(0)
    const reasons = skipped.map((s) => s.reason)
    expect(reasons).toContain('cancelled order')
    expect(reasons).toContain('order on hold')
  })

  it('accounts for every line it reads - nothing vanishes', () => {
    const result = mapVismaOrders(FIXTURES, OURS, DATES)
    expect(result.read).toBeGreaterThan(0)
    const counted = result.orders.length + result.skipped.reduce((n, s) => n + s.count, 0)
    expect(counted).toBe(result.read)
  })
})
