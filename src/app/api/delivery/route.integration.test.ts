import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { GET } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

let shopId: string

// Tagged and scoped — see "Test data convention" in the Global Constraints.
// The 11 seeded shops stay put: they have no deliveryTrackingFrom, so every
// order of theirs reads UNTRACKED and touches none of the assertions below.
// That makes this a stronger test than deleting them would.
const TAG = '[delivery-route-test]'
const TRACK = 'TROUTE' // every tracking number below starts with it
const scoped = { shop: { name: { contains: TAG } } }
// The unlinked parcel below must carry this prefix too — a bare literal has no
// prefix, so cleanup() would leave it behind and the next run's create() would
// fail on Shipment.trackingNumber's unique constraint (see link.integration.test.ts's
// IMPLEMENTER note for the exact same trap).
const UNLINKED = `${TRACK}9`

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } } })
  await db.shipment.deleteMany({ where: { OR: [{ order: scoped }, { trackingNumber: { startsWith: TRACK } }] } })
  await db.orderItem.deleteMany({ where: { order: scoped } })
  await db.order.deleteMany({ where: scoped })
  await db.shop.deleteMany({ where: { name: { contains: TAG } } })
  // DeliveryPromise has no shop to tag. Scope by the country codes this suite
  // writes so a parallel file's promises survive.
  await db.deliveryPromise.deleteMany({ where: { country: { in: ['*', 'NO'] } } })
}

afterAll(cleanup)

beforeEach(async () => {
  await cleanup()
  shopId = (await db.shop.create({
    data: {
      name: `Panetti ${TAG}`, currency: 'NOK', active: true,
      deliveryTrackingFrom: new Date('2026-01-01'),
    },
  })).id
  await db.deliveryPromise.create({
    data: { country: '*', days: 3, businessDays: true, effectiveFrom: new Date('2026-01-01') },
  })
})

const url = 'http://localhost/api/delivery?from=2026-08-01&to=2026-08-31'

describe('GET /api/delivery', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await GET(new Request(url))).status).toBe(403)
  })

  it('never lets a proxy or CDN keep a copy', async () => {
    const res = await GET(new Request(url))
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('reports the orders that are late right now', async () => {
    await db.order.create({
      // Order numbers are matched ACROSS ALL SHOPS by linkRows, so a bare
      // '1001' collides with other delivery suites' fixtures. Prefix it.
      data: {
        shopId, externalId: 'E1', number: 'RTE1001',
        placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed', currency: 'NOK',
        shippingCountry: 'NO',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      },
    })
    const body = await (await GET(new Request(url))).json()
    expect(body.stats.noTracking).toBe(1)
    // Still reported, and still past its promise — but in awaitingFile rather
    // than late, because we hold no parcel for it. See the split below.
    expect(body.awaitingFile[0].number).toBe('RTE1001')
    expect(body.awaitingFile[0].state).toBe('NO_TRACKING')
    expect(body.late).toEqual([])
  })

  /**
   * Live on 2026-08-18: roughly 120 late rows, of which SIX had a parcel. The
   * other ~114 were orders we simply had no warehouse file for, and listing
   * them under "missed its promise" both claimed something unprovable and
   * buried the only rows anyone could act on.
   *
   * A parcel is the difference between a delivery you chase the carrier about
   * and a file you chase the warehouse about. They are different jobs, so they
   * are different lists.
   */
  it('separates orders with a parcel to chase from orders with no file yet', async () => {
    const base = {
      shopId, placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed',
      currency: 'NOK', shippingCountry: 'NO',
      grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
    }
    const tracked = await db.order.create({
      data: { ...base, externalId: 'E-TRACKED', number: 'RTE2001' },
    })
    await db.order.create({ data: { ...base, externalId: 'E-BARE', number: 'RTE2002' } })
    await db.shipment.create({
      data: {
        trackingNumber: `${TRACK}CHASE`, carrier: 'DHL',
        orderId: tracked.id, lastStatus: 'IN_TRANSIT',
      },
    })

    const body = await (await GET(new Request(url))).json()

    expect(body.late.map((l: { number: string }) => l.number)).toEqual(['RTE2001'])
    expect(body.lateTotal).toBe(1)
    expect(body.late[0].parcels[0].carrier).toBe('DHL')

    expect(body.awaitingFile.map((l: { number: string }) => l.number)).toEqual(['RTE2002'])
    expect(body.awaitingFileTotal).toBe(1)
  })

  it('lists parcels no order claimed, so they are visible rather than lost', async () => {
    // No carrier given, so the column default applies — and the link has to
    // follow it. `url` is new: the page used to build this itself and always
    // built a Bring one, which was wrong for every DHL parcel.
    await db.shipment.create({ data: { trackingNumber: UNLINKED, lastStatus: 'IN_TRANSIT' } })
    const body = await (await GET(new Request(url))).json()
    expect(body.unlinked).toEqual([
      {
        trackingNumber: UNLINKED,
        lastStatus: 'IN_TRANSIT',
        carrier: 'Bring',
        url: `https://tracking.bring.com/tracking/${UNLINKED}`,
      },
    ])
  })

  it('links an unlinked DHL parcel to DHL, not to Bring', async () => {
    await db.shipment.create({
      data: { trackingNumber: `${UNLINKED}-DHL`, carrier: 'DHL', lastStatus: 'IN_TRANSIT' },
    })
    const body = await (await GET(new Request(url))).json()
    const parcel = body.unlinked.find((p: { trackingNumber: string }) =>
      p.trackingNumber === `${UNLINKED}-DHL`,
    )
    expect(parcel.url).toContain('dhl.com')
    expect(parcel.url).not.toContain('bring.com')
    // And it says so on screen. Both carriers feed this one list, so without a
    // name there is nothing to tell them apart by.
    expect(parcel.carrier).toBe('DHL')
  })

  it('reports the true count of unlinked parcels, not just the capped list', async () => {
    // Just over route.ts's take:50 cap, so the cap actually bites while the
    // fixture stays cheap. Every tracking number carries TRACK so cleanup()
    // can reach every one of them on the next run — a bare literal here is
    // exactly the trap 'lists parcels no order claimed' above already hit once.
    await db.shipment.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        trackingNumber: `${TRACK}U${i}`,
        lastStatus: 'IN_TRANSIT',
      })),
    })
    const body = await (await GET(new Request(url))).json()
    expect(body.unlinked.length).toBe(50)
    // Not an exact count: unlinked parcels have no shop to scope by by design
    // (that is the whole point of "visible rather than lost"), so this only
    // asserts what the fix promises — the total is never silently equal to
    // the capped page — rather than assuming nothing else is ever unlinked.
    expect(body.unlinkedTotal).toBeGreaterThan(body.unlinked.length)
    expect(body.unlinkedTotal).toBeGreaterThanOrEqual(51)
  })

  it('reports the true count of overdue orders, not just the shown page', async () => {
    // Just over route.ts's LATE_LIMIT (200), so the cap bites but the fixture
    // stays cheap. Same shape as 'reports the orders that are late right now'
    // above, just 201 of them in one createMany.
    //
    // These carry no shipment, so they land in awaitingFile — which is the
    // list that actually runs to hundreds in production, and so the one whose
    // cap most needs proving. Both lists are capped by the same LATE_LIMIT and
    // both report a true total beside it; asserting here covers the mechanism.
    const count = 201
    await db.order.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        shopId, externalId: `LATEBULK-${i}`, number: `RTE9${String(i).padStart(4, '0')}`,
        placedAt: new Date('2026-08-03T08:00:00Z'), status: 'completed', currency: 'NOK',
        shippingCountry: 'NO',
        grossSales: 0, discountTotal: 0, netSales: 0, shippingCharged: 0, taxTotal: 0, total: 0,
      })),
    })
    const body = await (await GET(new Request(url))).json()
    expect(body.awaitingFile.length).toBe(200)
    // Exact, unlike unlinkedTotal above: late orders ARE scoped to this test's
    // one tagged (and tracked) shop — the 11 seeded shops are all UNTRACKED
    // and never contribute — so the true count is fully known here.
    expect(body.awaitingFileTotal).toBe(count)
  })
})
