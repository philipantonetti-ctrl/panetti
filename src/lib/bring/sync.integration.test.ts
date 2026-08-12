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
const T3 = `${TRACK}3`

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

afterEach(() => {
  vi.unstubAllGlobals()
  // Fix round 1: the transaction-failure test below spies on db.$transaction.
  // Restored here rather than only at the end of that one test, so a spy left
  // behind by an assertion failure can never leak into a later test.
  vi.restoreAllMocks()
})
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
    // The REAL shape, captured from api.bring.com on 2026-08-07 with the
    // client's own credentials. Bring answers an unknown number with HTTP 200
    // and a consignmentSet holding an ERROR entry — not the empty array this
    // test used to assume, and not an HTTP error either. The outcome is the
    // same (the number never reaches byNumber, so it is recorded as unknown),
    // but the shape we assert against is now one Bring actually sends.
    stubBring([{ error: { code: 404, message: 'No shipments found' } }])
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

  // Fix round 1: the per-parcel success-path db.$transaction had no guard, so
  // a single failing write (a connection blip, a transaction timeout on a
  // parcel with a long history) propagated out of syncShipments entirely and
  // aborted every batch still queued behind it — worse under oldest-first
  // ordering, since the failing row would then sit at the head of the queue
  // and starve everything else on every later run too.
  it('a failed write for one parcel does not abort the batch behind it', async () => {
    // T1 sorts first (earlier nextPollAt), so its write is the one forced to
    // fail; T2 must still be reached, polled and stored despite T1's failure.
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01T00:00:00Z') } })
    await db.shipment.create({ data: { trackingNumber: T2, nextPollAt: new Date('2026-01-02T00:00:00Z') } })
    stubBring([
      consignment(T1, [{ status: 'HANDED_IN', dateIso: '2026-08-01T16:00:00Z' }]),
      consignment(T2, [{ status: 'HANDED_IN', dateIso: '2026-08-01T16:00:00Z' }]),
    ])

    // Reject the FIRST call to db.$transaction (T1's write), then fall
    // through to the real implementation so T2's write behaves normally.
    const realTransaction = db.$transaction.bind(db)
    let transactionCalls = 0
    vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
      transactionCalls++
      if (transactionCalls === 1) throw new Error('connection blip')
      return (realTransaction as unknown as (...a: unknown[]) => unknown)(...args)
    }) as unknown as typeof db.$transaction)

    const r = await syncShipments({ now })

    expect(r.polled).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.updated).toBe(1)

    const failedShipment = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
    expect(failedShipment.lastError).toMatch(/connection blip/)
    expect(failedShipment.terminal).toBe(false)
    expect(failedShipment.nextPollAt).toEqual(new Date(now.getTime() + HOUR))
    // The failed write must not have partially landed.
    expect(await db.shipmentEvent.count({ where: { shipmentId: failedShipment.id } })).toBe(0)

    const okShipment = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T2 } })
    expect(okShipment.handedInAt).toEqual(new Date('2026-08-01T16:00:00Z'))
    expect(okShipment.lastError).toBeNull()
    expect(await db.shipmentEvent.count({ where: { shipmentId: okShipment.id } })).toBe(1)
  })

  it('does not claim a successful sync when it reached no parcel at all', async () => {
    // A revoked Mybring key fails every request. Before this, the run still
    // stamped lastSyncAt and cleared lastError — and since this is the only
    // writer of that field, it could never be non-null. The settings page read
    // "Last synced: a minute ago" forever while nothing was being tracked.
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    vi.stubGlobal(
      'fetch',
      vi.fn<() => Promise<Response>>(async () => new Response('invalid api key', { status: 401 })),
    )

    const r = await syncShipments({ now })
    expect(r.polled).toBe(0)
    expect(r.failed).toBe(1)

    const cfg = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(cfg.lastError).toMatch(/could not reach bring/i)
    expect(cfg.lastSyncAt).toBeNull()
  })

  it('clears the error and stamps the time once a run reaches Bring again', async () => {
    await db.deliveryConfig.update({
      where: { id: 'singleton' },
      data: { lastError: 'Could not reach Bring for any parcel (3 failed).' },
    })
    await db.shipment.create({ data: { trackingNumber: T1, nextPollAt: new Date('2026-01-01') } })
    stubBring([consignment(T1, [{ status: 'IN_TRANSIT', dateIso: '2026-08-02T06:00:00Z' }])])

    await syncShipments({ now })

    const cfg = await db.deliveryConfig.findUniqueOrThrow({ where: { id: 'singleton' } })
    expect(cfg.lastError).toBeNull()
    expect(cfg.lastSyncAt).not.toBeNull()
  })

  // This file mocks the global fetch, not a fetchTracking function, so the
  // request shape is read off the URL's own `q` params rather than a mock's
  // call args. Three due parcels, not two: two due parcels makes the count
  // and shape assertions redundant — any batch size >= 2 collapses both into
  // one call and trips a count-floor check, while a batch size of 1 makes
  // "length 1" true by construction either way, so the count assertion would
  // always decide the test's fate first and the shape assertion would never
  // independently fail. Three is the smallest number that can produce a
  // PARTIAL batch (e.g. size 2 then size 1), which is what makes checking the
  // shape of every call — not just whether more than one call happened —
  // actually load-bearing. With a batch size above 1, at least one request
  // would carry more than one `q` param, and Bring answers about only one of
  // them (see file banner on client.ts / sync.ts), leaving the rest falsely
  // marked "does not know this number yet".
  it('asks Bring about one parcel per request — it answers about only one', async () => {
    for (const n of [T1, T2, T3]) {
      await db.shipment.create({ data: { trackingNumber: n, nextPollAt: new Date('2026-01-01') } })
    }
    const calls: string[][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn<(url: string) => Promise<Response>>(async (url) => {
        calls.push(new URL(url).searchParams.getAll('q'))
        return new Response(JSON.stringify({ consignmentSet: [] }), { status: 200 })
      }),
    )

    await syncShipments({ now })

    // Shape first: this is the assertion that actually catches a batch size
    // above 1. It must run and fail on its own, not be pre-empted by the
    // count check below.
    for (const numbers of calls) expect(numbers).toHaveLength(1)
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })
})
