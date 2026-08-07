import { describe, expect, it, beforeEach, vi, afterEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { nextPollFor, syncShipments } from './sync'
import type { Milestones } from './map'

const NONE: Milestones = {
  bookedAt: null, handedInAt: null, availableAt: null,
  collectedAt: null, outcome: null, lastStatus: null,
}
const now = new Date('2026-08-05T12:00:00Z')
const HOUR = 60 * 60 * 1000

// Unique to THIS file — see "Test data convention" in the Global Constraints.
// This suite creates no shop or order, so a shop-name TAG is not needed; only
// the tracking-number prefix is.
//
// DEVIATION FROM BRIEF: the brief's beforeEach ran bare
// `db.shipmentEvent.deleteMany()` / `db.shipment.deleteMany()` — no tag or
// prefix — which would sweep up every other delivery suite's shipments and
// events, exactly what the Global Constraints forbid ("Give your fixtures a
// tag and tracking-number prefix unique to your file, and scope every cleanup
// to them"). It also ran `db.deliveryConfig.deleteMany()` then `.create()`,
// which the Global Constraints separately and explicitly forbid for the
// DeliveryConfig singleton ("Never deleteMany() then create() — use upsert,
// and blank the fields rather than deleting the row. Two files racing must
// not make each other's row vanish."). This was already flagged once, in the
// Task 1 review (progress.md: "Task 8's sync test uses bare deleteMany on
// shipment, shipmentEvent and deliveryConfig") and deferred as a minor since
// Task 8 hadn't been written yet. Fixed here, now that it is: cleanup is
// scoped by TRACK below, and the singleton is upserted/blanked in place
// instead of deleted, matching link.integration.test.ts, schema.integration.
// test.ts and route.integration.test.ts's established convention.
const TRACK = 'TSYNC' // every tracking number this suite creates starts with it
const T1 = `${TRACK}1`
const T2 = `${TRACK}2`

const BRING_FIELDS = {
  bringApiUid: 'ops@example.com',
  bringApiKey: encryptSecret('k'),
  bringClientUrl: 'https://panetti.vercel.app',
}

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  // By prefix, not by `orderId: null` — an unlinked parcel belongs to no
  // shop, so `orderId: null` would delete another file's parcels too.
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
}

afterEach(() => vi.unstubAllGlobals())
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  // Upsert, never delete-then-create: the singleton must never vanish out
  // from under a parallel suite that also depends on it (e.g. a settings-page
  // test). Every field this suite cares about is reset explicitly instead, so
  // each test still starts from the same known-clean "configured" state the
  // brief's delete+create was after.
  await db.deliveryConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', ...BRING_FIELDS },
    update: { ...BRING_FIELDS, slackWebhookUrl: null, lastSyncAt: null, lastError: null },
  })
})

describe('nextPollFor', () => {
  it('checks a parcel that has not moved yet only every six hours', () => {
    const r = nextPollFor({ ...NONE, bookedAt: now }, null, now)
    expect(r.terminal).toBe(false)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 6 * HOUR)
  })

  it('checks a parcel in transit every two hours', () => {
    const r = nextPollFor({ ...NONE, handedInAt: now, lastStatus: 'IN_TRANSIT' }, null, now)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 2 * HOUR)
  })

  it('checks a parcel near or past its promise on every run', () => {
    const r = nextPollFor(
      { ...NONE, handedInAt: now, lastStatus: 'IN_TRANSIT' },
      new Date(now.getTime() + 6 * HOUR),
      now,
    )
    expect(r.nextPollAt!.getTime()).toBe(now.getTime())
  })

  it('checks a parcel waiting to be collected once a day', () => {
    const r = nextPollFor({ ...NONE, availableAt: now, lastStatus: 'READY_FOR_PICKUP' }, null, now)
    expect(r.nextPollAt!.getTime()).toBe(now.getTime() + 24 * HOUR)
  })

  it('stops polling a collected parcel', () => {
    const r = nextPollFor({ ...NONE, availableAt: now, collectedAt: now, outcome: 'DELIVERED' }, null, now)
    expect(r.terminal).toBe(true)
    expect(r.nextPollAt).toBeNull()
  })

  it('stops polling a returned parcel, which will never be collected', () => {
    expect(nextPollFor({ ...NONE, outcome: 'RETURNED' }, null, now).terminal).toBe(true)
  })

  it('gives up on a parcel nobody collected after 30 days', () => {
    const old = new Date(now.getTime() - 31 * 24 * HOUR)
    expect(nextPollFor({ ...NONE, availableAt: old }, null, now).terminal).toBe(true)
  })
})

describe('syncShipments', () => {
  function stubBring(consignments: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ consignmentSet: consignments }), { status: 200 })))
  }

  const consignment = (n: string, events: { status: string; dateIso: string }[]) => ({
    packageSet: [{ packageNumber: n, eventSet: events }],
  })

  it('stores events and milestones for a due parcel', async () => {
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    stubBring([consignment(T1, [
      { status: 'HANDED_IN', dateIso: '2026-08-01T16:00:00Z' },
      { status: 'DELIVERED', dateIso: '2026-08-04T11:00:00Z' },
    ])])

    const r = await syncShipments({ now })
    expect(r.polled).toBe(1)
    expect(r.updated).toBe(1)

    const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
    expect(s.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(s.availableAt).toEqual(new Date('2026-08-04T11:00:00Z'))
    expect(s.terminal).toBe(true)
    expect(await db.shipmentEvent.count({ where: { shipmentId: s.id } })).toBe(2)
  })

  it('never duplicates an event when the same reply arrives twice', async () => {
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    const reply = [consignment(T1, [{ status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z' }])]

    stubBring(reply)
    await syncShipments({ now })
    await db.shipment.update({ where: { trackingNumber: T1 }, data: { nextPollAt: new Date('2026-01-01') } })
    stubBring(reply)
    await syncShipments({ now })

    // DEVIATION FROM BRIEF: the brief asserted a bare, whole-table
    // `db.shipmentEvent.count()`. Scoped to this shipment's id instead — the
    // same fix as the cleanup above, for the same reason: a bare query over a
    // shared table reads other suites' rows, not just this file's.
    const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
    expect(await db.shipmentEvent.count({ where: { shipmentId: s.id } })).toBe(1)
  })

  it('leaves a parcel that is not due yet alone', async () => {
    await db.shipment.create({
      data: { trackingNumber: T1, nextPollAt: new Date('2026-09-01') },
    })
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    expect((await syncShipments({ now })).polled).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })

  // DEVIATION FROM BRIEF: titled "...and stops asking forever" in the brief,
  // which contradicts its own assertions (terminal: false, nextPollAt not
  // null) and the rule it is proving — "A number Bring does not know is not
  // an error... Record it and try later; do not mark it terminal." Retitled
  // to match what the test actually asserts; the body is unchanged.
  it('records a number Bring does not know, and keeps asking later', async () => {
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    stubBring([])
    await syncShipments({ now })
    const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
    expect(s.lastError).toMatch(/not know/i)
    // Still due later: the warehouse may not have handed it over yet.
    expect(s.terminal).toBe(false)
    expect(s.nextPollAt).not.toBeNull()
  })

  it('reports itself unconfigured rather than throwing', async () => {
    // DEVIATION FROM BRIEF: deleteMany() on the DeliveryConfig singleton,
    // forbidden by the Global Constraints. Blank the credential fields
    // instead — getDeliveryConfig reads exactly the same "not connected"
    // state from a row with null credentials as it does from no row at all.
    await db.deliveryConfig.update({
      where: { id: 'singleton' },
      data: { bringApiUid: null, bringApiKey: null, bringClientUrl: null },
    })
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    const r = await syncShipments({ now })
    expect(r.error).toMatch(/not connected/i)
    expect(r.polled).toBe(0)
  })

  it('stops when the deadline passes, leaving the rest for the next run', async () => {
    for (const n of [T1, T2]) {
      await db.shipment.create({ data: { trackingNumber: n, nextPollAt: new Date('2026-01-01') } })
    }
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    const r = await syncShipments({ now, deadline: Date.now() - 1 })
    expect(r.polled).toBe(0)
    expect(fn).not.toHaveBeenCalled()
  })
})
