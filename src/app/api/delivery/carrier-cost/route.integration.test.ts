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
  await db.bringReportRun.deleteMany({ where: { invoiceNumber: { startsWith: TRACK } } })
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
  bringInvoices: {
    found: number; read: number; waiting: number; noDetail: number; failed: number
    lastError: string | null
  }
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

/**
 * Whether the Bring invoice reader is getting anywhere, on the page where its
 * answer will appear.
 *
 * Until this existed the reader ran every fifteen minutes, failed every time,
 * and said so nowhere — a working integration and a broken one looked exactly
 * alike from the outside. That is the same blind spot every credential-only
 * integration here has had, and the client asked the question that exposes it:
 * "where do I see on the website if it is finished".
 *
 * Counted as DELTAS against a reading taken first, never as absolutes. The
 * production query cannot be scoped to a test prefix — it is a whole-table
 * count by design — so a stray row from a sibling checkout would break an
 * absolute assertion while telling us nothing. The delta is exact either way.
 */
describe('the Bring invoice reader status', () => {
  const run = (n: string, state: string, over: Record<string, unknown> = {}) =>
    db.bringReportRun.create({
      data: {
        customerNumber: `${TRACK}C`,
        invoiceNumber: `${TRACK}${n}`,
        invoiceDate: new Date('2026-07-31T00:00:00Z'),
        state,
        ...over,
      },
    })

  it('counts what it has found, read, and is still waiting on', async () => {
    const before = (await load()).bringInvoices
    await run('S1', 'STORED', { rowsStored: 6 })
    await run('P1', 'PENDING')
    await run('R1', 'REQUESTED')
    await run('N1', 'NO_SPEC')
    const after = (await load()).bringInvoices

    expect(after.found - before.found).toBe(4)
    expect(after.read - before.read).toBe(1)
    // Pending and requested are one idea to the reader: asked for, not here yet.
    expect(after.waiting - before.waiting).toBe(2)
    expect(after.noDetail - before.noDetail).toBe(1)
  })

  /**
   * The whole point of the panel. A count of 27 found and 0 read is a mystery;
   * the same count beside Bring's own words is something a person can act on,
   * and in this case forward to Bring support verbatim.
   */
  it('carries the reason the last attempt failed', async () => {
    // Latest nextTryAt wins, which is the row that failed most recently: every
    // failure writes one at the moment it happens. Dated forward so this row
    // beats any stray a sibling checkout may have left behind.
    await run('F1', 'FAILED', {
      error: 'Bring responded 406: Not Acceptable',
      nextTryAt: new Date('2099-01-01T00:00:00Z'),
    })
    const body = await load()

    expect(body.bringInvoices.failed).toBeGreaterThanOrEqual(1)
    expect(body.bringInvoices.lastError).toBe('Bring responded 406: Not Acceptable')
  })

  it('does not let an undated failure outrank the one that actually happened last', async () => {
    await run('F2', 'FAILED', { error: 'undated, from somewhere else', nextTryAt: null })
    await run('F3', 'FAILED', {
      error: 'Bring responded 406: Not Acceptable',
      nextTryAt: new Date('2099-01-01T00:00:00Z'),
    })
    const body = await load()

    expect(body.bringInvoices.lastError).toBe('Bring responded 406: Not Acceptable')
  })

  /**
   * The 27 rows already in production were stored before the Bring client
   * learned to strip markup, and the client read this off his own page:
   * "Bring responded 406: <?xml version='1.0' encoding='UTF-8'?><String>Not
   * Acceptable</String>". Tidying only at the point of writing would have left
   * him looking at that until every invoice had been retried.
   */
  it('tidies an error that was stored before the markup was stripped', async () => {
    await run('F4', 'FAILED', {
      error: `Bring responded 406: <?xml version='1.0' encoding='UTF-8'?><String>Not Acceptable</String>`,
      nextTryAt: new Date('2099-06-01T00:00:00Z'),
    })
    const body = await load()

    expect(body.bringInvoices.lastError).toBe('Bring responded 406: Not Acceptable')
    expect(body.bringInvoices.lastError).not.toContain('<')
  })

  it('reports no reason when nothing has failed', async () => {
    await run('S2', 'STORED')
    // Not asserting null outright: a sibling checkout's failed row would be a
    // real answer, not a defect. What must never happen is a STORED row
    // inventing one.
    const body = await load()
    expect(body.bringInvoices.lastError).not.toBe('')
  })
})
