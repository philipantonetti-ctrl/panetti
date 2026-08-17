import { describe, expect, it, beforeEach, vi, afterEach, afterAll } from 'vitest'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/secrets'
import { DHL_CALLS_PER_RUN, nextPollFor, syncShipments } from './sync'
import type { Milestones } from './milestones'

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
  vi.unstubAllEnvs()
  // Fix round 1: the transaction-failure test below spies on db.$transaction.
  // Restored here rather than only at the end of that one test, so a spy left
  // behind by an assertion failure can never leak into a later test.
  vi.restoreAllMocks()
})
afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  // DHL off unless a test says otherwise, so whether the machine running the
  // suite happens to have a DHL key exported cannot change what these assert.
  vi.stubEnv('DHL_API_KEY', '')
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

  /**
   * DHL, the second carrier. Its parcels were written by the file import with
   * `nextPollAt: null` precisely because this poller used to ask Bring about
   * every number regardless of carrier.
   */
  describe('with DHL connected', () => {
    const DUE = { nextPollAt: new Date('2026-01-01'), carrier: 'DHL' }
    /** Never really sleeps: DHL's spacing is six seconds and a suite is not. */
    const noSleep = async () => {}

    // Parameters declared, not inferred: without them mock.calls is typed as an
    // empty tuple and reading calls[0][1] does not compile.
    function stubDhl(status = 200, body: unknown = { shipments: [] }) {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        void url
        void init
        return new Response(JSON.stringify(body), { status })
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    const shipment = (id: string, statusCode: string) => ({
      shipments: [{
        id,
        events: [{ timestamp: '2026-08-02T06:00:00', statusCode, description: 'x' }],
      }],
    })

    it('asks DHL about a DHL parcel, using the header DHL expects', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      const fetchMock = stubDhl(200, shipment(T1, 'transit'))

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.polled).toBe(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toContain('api-eu.dhl.com')
      expect((init?.headers as Record<string, string>)['DHL-API-Key']).toBe('dhl-key')

      const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
      expect(s.handedInAt).toEqual(new Date('2026-08-02T06:00:00Z'))
    })

    /**
     * The whole reason dhl/link.ts refused to set a due date. Asking Bring about
     * a DHL number gets a confident "Bring does not know this number", which
     * reads as a warehouse mistake rather than a wiring one.
     */
    it('never asks Bring about a DHL parcel', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      const fetchMock = stubDhl(200, shipment(T1, 'transit'))

      await syncShipments({ now, sleep: noSleep })

      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.every((u) => !u.includes('bring.com'))).toBe(true)
    })

    /**
     * DHL allows 250 calls a day. Left uncapped, one run of a backlog would
     * spend the lot in a couple of minutes and every later run that day would
     * get 429s.
     */
    it('spends at most its share of the daily allowance in one run', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      for (const n of [T1, T2, T3]) {
        await db.shipment.create({ data: { trackingNumber: n, ...DUE } })
      }
      const fetchMock = stubDhl(200, { shipments: [] })

      const r = await syncShipments({ now, sleep: noSleep })

      expect(fetchMock).toHaveBeenCalledTimes(DHL_CALLS_PER_RUN)
      expect(r.dhlCalls).toBe(DHL_CALLS_PER_RUN)
    })

    it('leaves the parcels it could not reach this run first in line for the next', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      for (const n of [T1, T2, T3]) {
        await db.shipment.create({ data: { trackingNumber: n, ...DUE } })
      }
      stubDhl(200, { shipments: [] })

      await syncShipments({ now, sleep: noSleep })

      // Untouched: same due date, no error written. A parcel skipped for budget
      // has not failed, and must not look like it has.
      const skipped = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T3 } })
      expect(skipped.nextPollAt).toEqual(new Date('2026-01-01'))
      expect(skipped.lastError).toBeNull()
    })

    /**
     * The state this ships in. Nobody has set DHL_API_KEY yet, and a DHL parcel
     * must then sit exactly as it is — not be marked failed, which would paint
     * the Delivery page red for a carrier nobody has connected.
     */
    it('leaves a DHL parcel completely alone when no key is configured', async () => {
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      const fetchMock = stubDhl()

      const r = await syncShipments({ now, sleep: noSleep })

      expect(fetchMock).not.toHaveBeenCalled()
      expect(r.failed).toBe(0)
      const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
      expect(s.lastError).toBeNull()
      expect(s.nextPollAt).toEqual(new Date('2026-01-01'))
    })

    it('records a number DHL does not know yet without calling it a failure', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      stubDhl(404, { status: 404, title: 'No result found' })

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.failed).toBe(0)
      const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
      expect(s.lastError).toMatch(/DHL does not know this number yet/i)
    })

    it('records a rate limit as the failure it is, not as an unknown parcel', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      stubDhl(429, { status: 429 })

      const r = await syncShipments({ now, sleep: noSleep })

      expect(r.failed).toBe(1)
      const s = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T1 } })
      expect(s.lastError).toMatch(/429/)
    })

    /**
     * The gap between two DHL calls is six seconds of real time, and the run has
     * a deadline. Checking the clock, then sleeping past it, then asking anyway
     * gets a request with a 1ms budget, an abort, and a healthy parcel marked
     * failed — the poller inventing a failure out of its own waiting.
     *
     * The clock is stubbed rather than slept through, so the suite does not take
     * six seconds to assert it.
     */
    it('stops rather than sleeping past its own deadline', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      for (const n of [T1, T2]) {
        await db.shipment.create({ data: { trackingNumber: n, ...DUE } })
      }
      stubDhl(200, { shipments: [] })

      let clock = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => clock)
      // Advances the clock instead of waiting, so the second parcel's gap lands
      // the run past its deadline.
      const sleep = async (ms: number) => {
        clock += ms
      }

      // Enough for the first parcel, not enough to also wait out the gap.
      const r = await syncShipments({ now, deadline: clock + 1_000, sleep })

      expect(r.dhlCalls).toBe(1)
      expect(r.failed).toBe(0)
      const second = await db.shipment.findUniqueOrThrow({ where: { trackingNumber: T2 } })
      expect(second.lastError).toBeNull()
    })

    it('polls both carriers in one run', async () => {
      vi.stubEnv('DHL_API_KEY', 'dhl-key')
      await db.shipment.create({ data: { trackingNumber: T1, ...DUE } })
      await db.shipment.create({
        data: { trackingNumber: T2, carrier: 'BRING', nextPollAt: new Date('2026-01-02') },
      })

      vi.stubGlobal('fetch', vi.fn(async (url: string) =>
        String(url).includes('bring.com')
          ? new Response(JSON.stringify({ consignmentSet: [consignment(T2, [
              { status: 'HANDED_IN', dateIso: '2026-08-01T16:00:00Z' },
            ])] }), { status: 200 })
          : new Response(JSON.stringify(shipment(T1, 'transit')), { status: 200 })))

      const r = await syncShipments({ now, sleep: noSleep })
      expect(r.updated).toBe(2)
    })
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
    // Wording widened when this poller took on DHL: with two carriers it can no
    // longer name Bring. The claim is unchanged — nothing configured, nothing
    // polled, and no throw.
    expect(r.error).toMatch(/no carrier is connected/i)
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
    // Was /could not reach bring/. Same claim, carrier-neutral wording.
    expect(cfg.lastError).toMatch(/could not reach the carrier/i)
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
