import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '../secrets'
import { postWooTrackingNotes } from './woo-notes'

// Unique to THIS file - shops, orders and parcels are shared with every other test.
const TAG = '[woo-note-test]'
const PREFIX = '77NOTE'
const scoped = { shop: { name: { contains: TAG } } }

/** When each shop was switched on. Parcels older than this are out of reach. */
const SWITCHED_ON = new Date('2026-09-01T00:00:00Z')

let onId: string
let offId: string
let noKeysId: string

type Call = { url: string; method?: string; body: unknown; auth: string | undefined }

let calls: Call[] = []

/** One stubbed store, answering every note POST the same way. */
const stubStore = (answer: () => Response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get('Authorization') ?? undefined,
      })
      return answer()
    }),
  )
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const shop = (name: string, over: Record<string, unknown>) =>
  db.shop.create({ data: { name: `${name} ${TAG}`, currency: 'DKK', ...over } })

const withKeys = {
  wooUrl: 'https://panetti.example.test',
  wooKey: encryptSecret('ck_test'),
  wooSecret: encryptSecret('cs_test'),
}

const order = (shopId: string, number: string, externalId: string) =>
  db.order.create({
    data: {
      shopId,
      externalId,
      number,
      placedAt: new Date('2026-09-02T09:00:00Z'),
      status: 'processing',
      currency: 'DKK',
      grossSales: 1000,
      discountTotal: 0,
      netSales: 1000,
      shippingCharged: 0,
      taxTotal: 0,
      total: 1000,
      customerEmail: `${number}@example.test`,
    },
  })

/** A parcel, linked to an order unless `orderId` is given as null. */
const parcel = async (
  suffix: string,
  over: { orderId?: string | null; carrier?: string; createdAt?: Date } = {},
) =>
  db.shipment.create({
    data: {
      trackingNumber: `${PREFIX}${suffix}`,
      carrier: over.carrier ?? 'BRING',
      orderId: over.orderId === undefined ? null : over.orderId,
      createdAt: over.createdAt ?? new Date('2026-09-03T08:00:00Z'),
    },
  })

const stored = (suffix: string) =>
  db.shipment.findUniqueOrThrow({ where: { trackingNumber: `${PREFIX}${suffix}` } })

async function cleanupShipments() {
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: PREFIX } } })
}

async function cleanup() {
  await cleanupShipments()
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
}

beforeAll(async () => {
  await cleanup()
  onId = (await shop('Panetti Denmark', { ...withKeys, wooNotesFrom: SWITCHED_ON })).id
  offId = (await shop('Panetti Sweden', { ...withKeys, wooNotesFrom: null })).id
  noKeysId = (await shop('Mazzetti Norge', { wooNotesFrom: SWITCHED_ON })).id

  await order(onId, '14379', '9001')
  await order(offId, '14380', '9002')
  await order(noKeysId, '14381', '9003')
})

beforeEach(() => {
  calls = []
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await cleanupShipments()
})

afterAll(cleanup)

const orderIdOf = async (shopId: string) =>
  (await db.order.findFirstOrThrow({ where: { shopId }, select: { id: true } })).id

describe('postWooTrackingNotes', () => {
  it('writes one private note into the order and stamps the parcel with the note id', async () => {
    stubStore(() => json({ id: 4471 }))
    await parcel('0001', { orderId: await orderIdOf(onId) })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://panetti.example.test/wp-json/wc/v3/orders/9001/notes')
    expect(calls[0].method).toBe('POST')
    // The whole point of the feature: the customer must never see this or be
    // emailed about it. A missing field would default to false in Woo, but
    // saying it is what makes the intent readable in a request log.
    expect(calls[0].body).toEqual({
      note: 'Bring 77NOTE0001\nhttps://tracking.bring.com/tracking/77NOTE0001',
      customer_note: false,
    })
    expect(calls[0].auth).toBe(`Basic ${Buffer.from('ck_test:cs_test').toString('base64')}`)

    const after = await stored('0001')
    expect(after.wooNoteAt).toBeInstanceOf(Date)
    expect(after.wooNoteId).toBe(4471)
    expect(after.wooNoteError).toBeNull()
  })

  it('never posts the same parcel twice', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0002', { orderId: await orderIdOf(onId) })

    await postWooTrackingNotes()
    const second = await postWooTrackingNotes()

    expect(second.posted).toBe(0)
    expect(calls).toHaveLength(1)
  })

  /**
   * The switch. Every shop reads null until someone sets a date, so merging
   * this feature posts nothing anywhere.
   */
  it('leaves a shop that has not been switched on completely alone', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0003', { orderId: await orderIdOf(offId) })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(calls).toEqual([])
    expect((await stored('0003')).wooNoteAt).toBeNull()
  })

  /**
   * No backfill, structurally: the cutoff is compared against the parcel's own
   * createdAt, so switching a shop on can never reach into what is already
   * there.
   */
  it('ignores a parcel first seen before the shop was switched on', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0004', {
      orderId: await orderIdOf(onId),
      createdAt: new Date('2026-08-30T08:00:00Z'),
    })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(calls).toEqual([])
  })

  /**
   * A B2B order has no WooCommerce order behind it at all - its externalId is
   * something we made up (`b2b:B-0006`) or Visma's invoice number. Posting one
   * would ask a live store for an order id it has never heard of, and get a
   * 404 that reads exactly like a customer's order having been deleted.
   */
  it('never posts an order that did not come from the webshop', async () => {
    stubStore(() => json({ id: 1 }))
    const customer = await db.b2bCustomer.create({
      data: { shopId: onId, name: `Wholesale ${TAG}`, currency: 'DKK' },
    })
    const b2b = await db.order.create({
      data: {
        shopId: onId,
        externalId: 'b2b:B-0006',
        number: 'B-0006',
        placedAt: new Date('2026-09-02T09:00:00Z'),
        status: 'completed',
        currency: 'DKK',
        grossSales: 1000, discountTotal: 0, netSales: 1000,
        shippingCharged: 0, taxTotal: 0, total: 1000,
        b2bCustomerId: customer.id,
      },
    })
    await parcel('0013', { orderId: b2b.id })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(calls).toEqual([])
    expect((await stored('0013')).wooNoteAt).toBeNull()

    await db.order.delete({ where: { id: b2b.id } })
    await db.b2bCustomer.delete({ where: { id: customer.id } })
  })

  it('ignores a parcel that has not been matched to an order yet', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0005')

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(calls).toEqual([])
  })

  it('skips a switched-on shop whose WooCommerce keys are missing, without failing the run', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0006', { orderId: await orderIdOf(noKeysId) })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(result.failed).toBe(0)
    expect(calls).toEqual([])
  })

  /**
   * The order is gone from the store - trashed, or deleted outright. There is
   * nothing to post to and there never will be, so the parcel is stamped and
   * leaves the queue. Retrying it every fifteen minutes forever is the failure
   * mode this prevents.
   */
  it('stops trying when the store says the order does not exist', async () => {
    stubStore(() => json({ code: 'woocommerce_rest_shop_order_invalid_id' }, 404))
    await parcel('0007', { orderId: await orderIdOf(onId) })

    const result = await postWooTrackingNotes()

    expect(result.posted).toBe(0)
    expect(result.failed).toBe(1)
    const after = await stored('0007')
    expect(after.wooNoteAt).toBeInstanceOf(Date)
    expect(after.wooNoteId).toBeNull()
    expect(after.wooNoteError).toContain('404')

    calls = []
    await postWooTrackingNotes()
    expect(calls).toEqual([])
  })

  /**
   * A store that is down, rate-limiting or mid-deploy. The parcel keeps its
   * place in the queue and is tried again next tick, with the reason recorded
   * in the meantime.
   */
  it('leaves a parcel for the next run when the store fails, and says why', async () => {
    stubStore(() => json({ message: 'Internal server error' }, 500))
    await parcel('0008', { orderId: await orderIdOf(onId) })

    const result = await postWooTrackingNotes()

    expect(result.failed).toBe(1)
    const after = await stored('0008')
    expect(after.wooNoteAt).toBeNull()
    expect(after.wooNoteError).toContain('500')

    calls = []
    await postWooTrackingNotes()
    expect(calls).toHaveLength(1)
  })

  it('posts no more than the run is allowed, leaving the rest for the next one', async () => {
    stubStore(() => json({ id: 1 }))
    const orderId = await orderIdOf(onId)
    await parcel('0009', { orderId })
    await parcel('0010', { orderId })
    await parcel('0011', { orderId })

    const result = await postWooTrackingNotes({ maxNotes: 2 })

    expect(result.posted).toBe(2)
    expect(calls).toHaveLength(2)
    expect(await db.shipment.count({ where: { trackingNumber: { startsWith: PREFIX }, wooNoteAt: null } })).toBe(1)
  })

  it('stops when the run is out of time', async () => {
    stubStore(() => json({ id: 1 }))
    await parcel('0012', { orderId: await orderIdOf(onId) })

    const result = await postWooTrackingNotes({ deadline: Date.now() - 1 })

    expect(result.posted).toBe(0)
    expect(calls).toEqual([])
  })
})
