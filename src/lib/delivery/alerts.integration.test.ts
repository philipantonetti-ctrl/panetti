import { describe, expect, it, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { alertMessage, flushDeliveryAlerts } from './alerts'
import { trackingUrl } from './tracking-url'

const NOW = new Date('2026-08-20T12:00:00Z')
let shopId: string

afterEach(() => vi.unstubAllGlobals())

// Tagged and scoped — see "Test data convention" in the Global Constraints.
const TAG = '[delivery-alerts-test]'
const TRACK = 'TALERT' // every tracking number below starts with it
const scoped = { shop: { name: { contains: TAG } } }

// IMPLEMENTER: every shipment this file persists uses one of these instead of
// a bare 'T1' literal — a bare literal has no TALERT prefix, so cleanup()'s
// trackingNumber-prefix branch could not find it (see link.integration.test.ts's
// IMPLEMENTER note and route.integration.test.ts's UNLINKED comment for the
// exact same trap). Each of these shipments is also linked via orderId to a
// scoped order, so cleanup()'s `order: scoped` branch already covers them —
// but the prefix is kept so every persisted row is self-describing and the
// two cleanup branches agree with what the constants claim.
const T1 = `${TRACK}1`

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } } })
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  await db.deliveryPromise.deleteMany({ where: { country: { in: ['*'] } } })
  // Never deleteMany on the singleton — blank the fields instead, so a racing
  // file cannot find the row missing. See the Global Constraints.
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {
      bringApiUid: null, bringApiKey: null, bringClientUrl: null, slackWebhookUrl: null,
      // Reset too, or a stale row from an earlier test in this file (or a
      // failed run) lets "clears the last error" pass without the code under
      // test ever having cleared anything. lastError belongs to the Bring
      // sync (src/lib/bring/sync.ts), not this file, but blanked anyway so
      // the singleton starts every test fully clean, not just partially.
      lastError: null,
      slackLastError: null,
    },
  })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()

  shopId = (await db.shop.create({
    data: { name: `Panetti ${TAG}`, currency: 'NOK', deliveryTrackingFrom: new Date('2026-01-01') },
  })).id
  await db.deliveryPromise.create({
    data: { country: '*', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  })
  // Upsert, not create: cleanup() above already leaves the singleton row in
  // place — blanked, never deleted, per the Global Constraints — so a plain
  // create() here would collide with its own primary key on every test after
  // the first. Matches sync.integration.test.ts's established convention.
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', slackWebhookUrl: encryptSecret('https://hooks.slack.com/services/x') },
    update: { slackWebhookUrl: encryptSecret('https://hooks.slack.com/services/x') },
  })
})

async function order(number: string, over: Record<string, unknown> = {}) {
  return db.order.create({
    // Order numbers are matched ACROSS ALL SHOPS by linkRows, and
    // flushDeliveryAlerts scans every tracked shop with no shop filter. Both
    // make a bare '1001' collide with other delivery suites. Prefix every one.
    data: {
      shopId, externalId: `E${number}`, number: `ALRT${number}`,
      placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed', currency: 'NOK',
      shippingCountry: 'NO',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      ...over,
    },
  })
}

const ok = () => {
  // Typed as a type argument, not inferred: `vi.fn(async () => ...)` alone
  // infers a ZERO-ARG mock, which makes `fn.mock.calls[0][1]` below a type
  // error — indexing an empty tuple — even though it works at runtime.
  const fn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () => new Response('ok', { status: 200 }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('flushDeliveryAlerts', () => {
  it('alerts an order past its promise with no parcel, once', async () => {
    const o = await order('1001')
    const fn = ok()

    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAlertedAt).not.toBeNull()

    // Second run: nothing new, so nothing is posted at all.
    const again = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(again).not.toHaveBeenCalled()
  })

  it('leaves the order unstamped when Slack fails, so the next run retries', async () => {
    const o = await order('1001')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })))

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(0)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAlertedAt).toBeNull()
  })

  it('records why Slack failed, so a broken webhook is not silent', async () => {
    await order('1001')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_token', { status: 403 })))

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(0)
    expect(r.skipped).toMatch(/403/)

    const cfg = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(cfg.slackLastError).toMatch(/403/)
  })

  it('clears the last error once Slack accepts again', async () => {
    await db.deliveryConfig.update({
      where: { id: 'singleton' }, data: { slackLastError: 'Slack responded 403: invalid_token' },
    })
    await order('1001')
    ok()

    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(1)
    const cfg = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(cfg.slackLastError).toBeNull()
  })

  it('keeps the Slack error when a Bring sync runs afterwards', async () => {
    // sync.ts clears DeliveryConfig.lastError on every successful run. Before
    // these were separate fields it took the Slack failure with it, inside one
    // cron tick, and the settings page went quiet about a webhook that was still
    // broken.
    await order('1001')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid_token', { status: 403 })))
    await flushDeliveryAlerts({ now: NOW })

    // Exactly what the Bring sync does at the end of a run.
    await db.deliveryConfig.update({
      where: { id: 'singleton' }, data: { lastSyncAt: new Date(), lastError: null },
    })

    const cfg = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(cfg.slackLastError).toMatch(/403/)
  })

  it('never alerts a refunded order, which is never going to be delivered', async () => {
    await order('1001', { status: 'refunded' })
    const fn = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('never alerts a shop that is not delivery-tracked', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: null } })
    await order('1001')
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  it('never alerts an order placed before tracking started', async () => {
    await db.shop.update({ where: { id: shopId }, data: { deliveryTrackingFrom: new Date('2026-08-10') } })
    await order('1001')
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  it('does not alert an order that arrived late, since nobody can act on it now', async () => {
    // It missed its promise and the on-time rate records that. But the parcel
    // is with the customer, so an alert would be noise.
    const o = await order('1001')
    await db.shipment.create({
      data: {
        trackingNumber: T1, orderId: o.id,
        availableAt: new Date('2026-08-15T09:00:00Z'), // well past a 3-day promise
        outcome: 'DELIVERED', terminal: true,
      },
    })
    const fn = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not alert an order that arrived in time', async () => {
    const o = await order('1001')
    await db.shipment.create({
      data: {
        trackingNumber: T1, orderId: o.id,
        availableAt: new Date('2026-08-05T09:00:00Z'), outcome: 'DELIVERED', terminal: true,
      },
    })
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })

  /**
   * COLLECTED stops the clock in milestones.ts, but only READY_FOR_PICKUP and
   * DELIVERED write `availableAt`. A parcel whose feed carried the collection
   * and neither of those has a `collectedAt` and no `availableAt` at all — and
   * a rule reading `availableAt` alone paged somebody about a box the customer
   * had already walked home with.
   */
  it('does not alert a parcel the customer has collected, dateless though the arrival is', async () => {
    const o = await order('1001')
    await db.shipment.create({
      data: {
        trackingNumber: T1, orderId: o.id,
        collectedAt: new Date('2026-08-15T09:00:00Z'), terminal: true,
      },
    })
    const fn = ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  it('alerts a returned parcel, because the customer never got their order', async () => {
    const o = await order('1001')
    await db.shipment.create({
      data: { trackingNumber: T1, orderId: o.id, outcome: 'RETURNED', terminal: true },
    })
    ok()
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(1)
  })

  it('says it is not configured rather than failing, when there is no webhook', async () => {
    // Blank the field in place rather than deleteMany() on the singleton —
    // forbidden by the Global Constraints ("never deleteMany() ... blank the
    // fields rather than deleting the row"). getDeliveryConfig() reads exactly
    // the same "not connected" state from a row with a null webhook as it does
    // from no row at all, so this proves the same thing without ever letting
    // the singleton row disappear out from under a racing suite.
    await db.deliveryConfig.update({ where: { id: 'singleton' }, data: { slackWebhookUrl: null } })
    await order('1001')
    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(0)
    expect(r.skipped).toMatch(/Slack/)
  })

  it('sends one message for many orders, capped, and stamps every one of them', async () => {
    for (let i = 0; i < 30; i++) await order(`10${i}`)
    const fn = ok()

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(30)
    expect(fn).toHaveBeenCalledTimes(1)

    const text = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string).text
    expect(text).toMatch(/30 orders/)
    expect(text).toMatch(/and 5 more/)
    // Every one is stamped, capped message or not: a line we chose not to print
    // must not alert again tomorrow as if it were new.
    //
    // DEVIATION FROM BRIEF: the brief asserted a bare, whole-table
    // `db.order.count({ where: { deliveryAlertedAt: null } })`. Scoped to this
    // file's own shop instead — the same fix sync.integration.test.ts already
    // made for shipmentEvent, for the same reason: a bare query over a shared
    // table reads the 11 seeded shops' orders and every other suite's fixtures
    // too, not just this file's 30.
    expect(await db.order.count({ where: { deliveryAlertedAt: null, shopId } })).toBe(0)
  })

  it('still alerts a genuinely late order when the candidate queue is full of old, delivered ones', async () => {
    // The starvation bug this test exists to catch: an on-time delivery is
    // never stamped, so deliveryAlertedAt stays null forever. Ordered oldest
    // first under CANDIDATE_LIMIT, a big enough backlog of old, delivered
    // orders would permanently occupy every slot — the run would report
    // alertsSent: 0 while looking perfectly healthy. More than CANDIDATE_LIMIT
    // of them here (bulk-inserted for speed), all older than the one order
    // that is genuinely late right now.
    const OLD_COUNT = 501 // just over CANDIDATE_LIMIT (500)
    const oldOrders = Array.from({ length: OLD_COUNT }, (_, i) => ({
      id: `${TRACK}old${i}`, // doubles as its own shipment's tracking number below
      shopId, externalId: `Eold${i}`, number: `ALRTold${i}`,
      placedAt: new Date('2026-07-01T08:00:00Z'), status: 'completed', currency: 'NOK',
      shippingCountry: 'NO',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    }))
    await db.order.createMany({ data: oldOrders })
    await db.shipment.createMany({
      data: oldOrders.map((o) => ({
        trackingNumber: o.id, orderId: o.id,
        availableAt: new Date('2026-07-03T09:00:00Z'), outcome: 'DELIVERED', terminal: true,
      })),
    })

    const o = await order('1001') // placedAt 2026-08-03, no shipment: genuinely late right now
    const fn = ok()

    const r = await flushDeliveryAlerts({ now: NOW })
    expect(r.sent).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryAlertedAt).not.toBeNull()
  })

  it('does not alert an order placed before the alert window, even if still outstanding', async () => {
    // Without a floor, an order that never shipped and never alerted
    // accumulates the same way an on-time delivery does. It alerted when it
    // first went late, or the feature was not running yet — either way,
    // paging someone about it today changes nothing.
    await order('1001', { placedAt: new Date('2026-01-01T08:00:00Z') }) // ~230 days before NOW, well past the 90-day window
    expect((await flushDeliveryAlerts({ now: NOW })).sent).toBe(0)
  })
})

describe('alertMessage', () => {
  it('names the order, the shortfall and what is actually happening', () => {
    const text = alertMessage(
      [{ id: 'o1', number: '1001', shop: 'Panetti', country: 'NO',
         daysOver: 2, promiseDays: 3, state: 'NO_TRACKING', parcels: [] }],
      'https://panetti.vercel.app',
    )
    expect(text).toContain('1001')
    expect(text).toContain('Panetti')
    expect(text).toContain('2 days over')
    expect(text).toContain('Not shipped')
    expect(text).toContain('https://panetti.vercel.app/orders')
  })

  it('links the parcel on Bring when there is one', () => {
    const text = alertMessage(
      [{ id: 'o1', number: '1001', shop: 'Panetti', country: 'NO',
         daysOver: 1, promiseDays: 3, state: 'IN_TRANSIT',
         parcels: [{ number: 'T1', carrier: 'Bring', url: 'https://tracking.bring.com/tracking/T1' }] }],
      'https://panetti.vercel.app',
    )
    expect(text).toContain('tracking.bring.com/tracking/T1')
  })

  /**
   * The alert is the link the client actually clicks — he reads Slack, not the
   * delivery page. So this is the one that mattered most: every late DHL parcel
   * was sending him to Bring's site, which has never heard of the number.
   */
  it('links a DHL parcel to DHL, not to Bring', () => {
    const text = alertMessage(
      [{ id: 'o1', number: '1001', shop: 'Panetti', country: 'DE',
         daysOver: 1, promiseDays: 3, state: 'IN_TRANSIT',
         parcels: [{ number: '9599861672', carrier: 'DHL', url: trackingUrl('9599861672', 'DHL') }] }],
      'https://panetti.vercel.app',
    )
    expect(text).toContain('dhl.com')
    expect(text).not.toContain('bring.com')
  })
})
