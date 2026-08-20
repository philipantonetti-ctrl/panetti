import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest'
import { db } from '@/lib/db'

vi.mock('@/lib/auth/current-user', () => ({
  currentUser: vi.fn(async () => ({ id: 'u1', email: 'a@b.c', role: 'ADMIN' })),
}))

const { GET, PUT } = await import('./route')
const { currentUser } = await import('@/lib/auth/current-user')

// Tagged and scoped — see "Test data convention" in the Global Constraints.
// CarrierCost hangs off no shop, so it is scoped by these carrier names
// instead; a real BRING row must survive this suite untouched.
const TRACK = 'TCOST'
const BRINGISH = 'TESTBRING'
const DHLISH = 'TESTDHL'

async function cleanup() {
  await db.shipmentEvent.deleteMany({ where: { shipment: { trackingNumber: { startsWith: TRACK } } } })
  await db.shipment.deleteMany({ where: { trackingNumber: { startsWith: TRACK } } })
  await db.carrierCost.deleteMany({ where: { carrier: { in: [BRINGISH, DHLISH] } } })
}

afterAll(cleanup)
beforeEach(cleanup)

const url = 'http://localhost/api/delivery/carrier-cost?from=2026-07-01&to=2026-08-31'

const parcel = (n: string, carrier: string, handedInAt: Date) =>
  db.shipment.create({ data: { trackingNumber: `${TRACK}${n}`, carrier, handedInAt } })

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/delivery/carrier-cost', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

type Body = {
  carriers: { carrier: string; shipments: number; parcelsInRange: number; cost: number | null; averageMinor: number | null; monthsMissingCost: string[] }[]
  months: { carrier: string; month: string; parcels: number; amount: number | null }[]
}

const load = async () => (await (await GET(new Request(url))).json()) as Body
const of = (b: Body, carrier: string) => b.carriers.find((c) => c.carrier === carrier)

describe('GET /api/delivery/carrier-cost', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await GET(new Request(url))).status).toBe(403)
  })

  it('counts the parcels a carrier moved, by the month it took them', async () => {
    await parcel('1', BRINGISH, new Date('2026-07-04T09:00:00Z'))
    await parcel('2', BRINGISH, new Date('2026-07-20T09:00:00Z'))
    await parcel('3', BRINGISH, new Date('2026-08-02T09:00:00Z'))

    const body = await load()
    const july = body.months.find((m) => m.carrier === BRINGISH && m.month === '2026-07')
    expect(july?.parcels).toBe(2)
    expect(body.months.find((m) => m.carrier === BRINGISH && m.month === '2026-08')?.parcels).toBe(1)
  })

  it('keeps carriers apart, because they bill separately', async () => {
    await parcel('1', BRINGISH, new Date('2026-07-04T09:00:00Z'))
    await parcel('2', DHLISH, new Date('2026-07-04T09:00:00Z'))

    const body = await load()
    expect(of(body, BRINGISH)?.parcelsInRange).toBe(1)
    expect(of(body, DHLISH)?.parcelsInRange).toBe(1)
  })

  /**
   * The whole point. Nothing here comes from a carrier API — the tracking
   * endpoints return no money at all — so the invoice is entered and this
   * divides it by parcels we counted ourselves.
   */
  it('divides the invoice by the parcels once the invoice is known', async () => {
    await parcel('1', BRINGISH, new Date('2026-07-04T09:00:00Z'))
    await parcel('2', BRINGISH, new Date('2026-07-20T09:00:00Z'))
    await put({ carrier: BRINGISH, month: '2026-07', amount: 10_000, currency: 'NOK' })

    const row = of(await load(), BRINGISH)
    expect(row?.cost).toBe(10_000)
    expect(row?.shipments).toBe(2)
    expect(row?.averageMinor).toBe(5_000)
  })

  // Counting August's parcels against July's invoice alone would report a
  // saving nobody made, so the uninvoiced month is dropped and named.
  it('leaves out a month with no invoice and says which', async () => {
    await parcel('1', BRINGISH, new Date('2026-07-04T09:00:00Z'))
    await parcel('2', BRINGISH, new Date('2026-08-04T09:00:00Z'))
    await put({ carrier: BRINGISH, month: '2026-07', amount: 10_000, currency: 'NOK' })

    const row = of(await load(), BRINGISH)
    expect(row?.shipments).toBe(1)
    expect(row?.parcelsInRange).toBe(2)
    expect(row?.averageMinor).toBe(10_000)
    expect(row?.monthsMissingCost).toEqual(['2026-08'])
  })
})

describe('PUT /api/delivery/carrier-cost', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(currentUser).mockResolvedValueOnce({ id: 'u2', email: 'x@y.z', role: 'AMBASSADOR' } as never)
    expect((await put({ carrier: BRINGISH, month: '2026-07', amount: 1, currency: 'NOK' })).status).toBe(403)
  })

  it('replaces the figure for a month rather than adding a second row', async () => {
    await put({ carrier: BRINGISH, month: '2026-07', amount: 10_000, currency: 'NOK' })
    await put({ carrier: BRINGISH, month: '2026-07', amount: 12_000, currency: 'NOK' })

    const rows = await db.carrierCost.findMany({ where: { carrier: BRINGISH } })
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(12_000)
  })

  // Zero is a real figure — "they billed us nothing" — so clearing has to be
  // its own instruction rather than storing a zero and hoping.
  it('clears the month when the amount is null', async () => {
    await put({ carrier: BRINGISH, month: '2026-07', amount: 10_000, currency: 'NOK' })
    await put({ carrier: BRINGISH, month: '2026-07', amount: null })

    expect(await db.carrierCost.count({ where: { carrier: BRINGISH } })).toBe(0)
  })

  it('keeps a zero, which is not the same as no figure', async () => {
    await put({ carrier: BRINGISH, month: '2026-07', amount: 0, currency: 'NOK' })
    expect(await db.carrierCost.count({ where: { carrier: BRINGISH } })).toBe(1)
  })

  it('refuses a month that is not one', async () => {
    expect((await put({ carrier: BRINGISH, month: 'August', amount: 1, currency: 'NOK' })).status).toBe(400)
    expect((await put({ carrier: BRINGISH, month: '2026-13', amount: 1, currency: 'NOK' })).status).toBe(400)
  })

  it('refuses a fractional amount, because minor units are whole', async () => {
    expect((await put({ carrier: BRINGISH, month: '2026-07', amount: 10.5, currency: 'NOK' })).status).toBe(400)
  })

  it('refuses a currency that is not a three-letter code', async () => {
    expect((await put({ carrier: BRINGISH, month: '2026-07', amount: 10, currency: 'kroner' })).status).toBe(400)
  })
})
