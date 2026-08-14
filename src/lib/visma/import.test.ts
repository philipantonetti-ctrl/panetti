import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { resetVismaTokenCache } from './client'
import { importVismaPurchaseOrders, PAGE_SIZE } from './import'

const TAG = `TEST-VISMA-${Date.now()}`
const SKU = `${TAG}-A`

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** An order the mapper will accept: open, not held, one line for our SKU. */
const vismaOrder = (over: Record<string, unknown> = {}) => ({
  orderNbr: TAG,
  status: { value: 'Open' },
  hold: { value: false },
  date: { value: '2026-06-01' },
  promisedOn: { value: '2026-09-01' },
  lastModifiedDateTime: { value: '2026-07-15T09:00:00Z' },
  purchaseReceipts: [] as unknown[],
  lines: [
    {
      lineNbr: 1,
      inventory: { number: { value: SKU } } as Record<string, unknown>,
      orderQty: { value: 800 },
      qtyOnReceipts: { value: 300 },
      promised: { value: '2026-08-20' },
      completed: { value: false },
      canceled: false,
    },
  ],
  ...over,
})

/** Finished, with a receipt that dates it. */
const closedOrder = () =>
  vismaOrder({
    status: { value: 'Closed' },
    purchaseReceipts: [{ receiptNumber: { value: 'R-1' } }],
    lines: [
      {
        lineNbr: 1,
        inventory: { number: { value: SKU } },
        orderQty: { value: 800 },
        qtyOnReceipts: { value: 800 },
        promised: { value: '2026-08-20' },
        completed: { value: true },
        canceled: false,
      },
    ],
  })

const RECEIPTS = [
  { receiptNbr: { value: 'R-1' }, status: { value: 'Released' }, date: { value: '2026-08-18' } },
]

/** Routes the token call, the orders call and the receipts call. */
const stubVisma = (orders: unknown[], receipts: unknown[] = RECEIPTS) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
      if (u.includes('purchasereceipt')) return json(receipts)
      return json(orders)
    }),
  )

beforeEach(async () => {
  resetVismaTokenCache()
  vi.stubEnv('VISMA_CLIENT_ID', 'cid')
  vi.stubEnv('VISMA_CLIENT_SECRET', 'sec')
  vi.stubEnv('VISMA_TENANT_ID', 'tid')
  await db.supplyItem.create({ data: { sku: SKU, name: `${TAG} Pasta Maker` } })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await db.purchaseOrder.deleteMany({ where: { item: { sku: { startsWith: TAG } } } })
  await db.supplyItem.deleteMany({ where: { sku: { startsWith: TAG } } })
})

describe('importVismaPurchaseOrders', () => {
  it('stores ordered and received as two numbers', async () => {
    stubVisma([vismaOrder()])

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(1)
    expect(result.error).toBeNull()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    expect(row).toMatchObject({
      externalId: `${TAG}-1`,
      quantity: 800,
      receivedQuantity: 300,
      receivedAt: null,
    })
    expect(row!.eta).toEqual(new Date('2026-08-20T00:00:00Z'))
  })

  it('dates a finished order from its receipt, not from lastModified', async () => {
    stubVisma([closedOrder()])
    await importVismaPurchaseOrders()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    // The receipt says 18 Aug; lastModifiedDateTime says 15 Jul. The receipt wins.
    expect(row!.receivedAt).toEqual(new Date('2026-08-18T00:00:00Z'))
  })

  it('re-running changes nothing, because the import is keyed on Visma"s own id', async () => {
    stubVisma([vismaOrder()])
    await importVismaPurchaseOrders()
    await importVismaPurchaseOrders()

    expect(await db.purchaseOrder.count({ where: { item: { sku: SKU } } })).toBe(1)
  })

  it('moves the received figure when more units land', async () => {
    stubVisma([vismaOrder()])
    await importVismaPurchaseOrders()

    vi.unstubAllGlobals()
    resetVismaTokenCache()
    stubVisma([closedOrder()])
    await importVismaPurchaseOrders()

    const row = await db.purchaseOrder.findFirst({ where: { item: { sku: SKU } } })
    expect(row!.receivedQuantity).toBe(800)
    expect(row!.receivedAt).not.toBeNull()
  })

  it('never touches a hand-entered row', async () => {
    const item = await db.supplyItem.findFirstOrThrow({ where: { sku: SKU } })
    const mine = await db.purchaseOrder.create({
      data: { supplyItemId: item.id, quantity: 42, orderedAt: new Date('2026-01-01T00:00:00Z') },
    })
    stubVisma([vismaOrder()])

    await importVismaPurchaseOrders()

    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: mine.id } })
    expect(after.quantity).toBe(42)
    expect(after.externalId).toBeNull()
    expect(after.receivedQuantity).toBeNull()
  })

  it('is skipped, not failed, when no credentials are configured', async () => {
    vi.stubEnv('VISMA_CLIENT_ID', '')
    vi.stubEnv('VISMA_CLIENT_SECRET', '')
    vi.stubEnv('VISMA_TENANT_ID', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await importVismaPurchaseOrders()
    expect(result).toMatchObject({ configured: false, imported: 0, error: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a Visma outage instead of throwing into the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('connect/token')
          ? json({ access_token: 'tok', expires_in: 3600 })
          : json({ error: 'down' }, 503),
      ),
    )

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(0)
    expect(result.error).toMatch(/503/)
  })

  it('still imports when the receipts call fails, because dates are not the point', async () => {
    // Losing the dates must not lose the orders.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('connect/token')) return json({ access_token: 'tok', expires_in: 3600 })
        if (u.includes('purchasereceipt')) return json({ error: 'down' }, 503)
        return json([vismaOrder()])
      }),
    )

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(1)
    expect(result.error).toBeNull()
  })

  it('counts a line for a product we do not sell', async () => {
    const foreign = vismaOrder()
    foreign.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
    stubVisma([foreign])

    const result = await importVismaPurchaseOrders()
    expect(result.imported).toBe(0)
    expect(result.skipped).toContainEqual({ reason: 'not our product', count: 1 })
  })

  it('says so when the page came back full, rather than reporting a clean run', async () => {
    // A full page means orders past it were dropped, which otherwise looks
    // exactly like a company that has no more. Foreign SKUs so the test costs
    // 500 map operations rather than 500 writes.
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => {
      const o = vismaOrder({ orderNbr: `${TAG}-${i}` })
      o.lines[0].inventory = { number: { value: 'COSORI-NOT-OURS' } }
      return o
    })
    stubVisma(full)

    expect((await importVismaPurchaseOrders()).truncated).toBe(true)
  })

  it('does not claim truncation on a normal page', async () => {
    stubVisma([vismaOrder()])
    expect((await importVismaPurchaseOrders()).truncated).toBe(false)
  })
})
