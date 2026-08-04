import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { storeOrder, syncAllShops, syncShop } from './sync'
import { encryptSecret } from '../secrets'
import { db } from '../db'

async function cleanup() {
  await db.shop.deleteMany({ where: { name: { contains: '[sync-test]' } } })
  await db.ambassador.deleteMany({ where: { email: { contains: '[sync-test]' } } })
}
beforeEach(cleanup)
afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const jsonPage = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const emptyPage = () => jsonPage([])

/** A full, mappable WooCommerce order. */
function wooOrder(id: number, placedAt: string) {
  return {
    id,
    number: String(id),
    status: 'completed',
    currency: 'NOK',
    date_created_gmt: placedAt,
    discount_total: '0.00',
    discount_tax: '0.00',
    shipping_total: '0.00',
    shipping_tax: '0.00',
    total_tax: '25.00',
    total: '125.00',
    coupon_lines: [],
    line_items: [
      {
        id: id * 10,
        product_id: 900001,
        sku: 'SKU-1',
        name: 'Massager',
        quantity: 1,
        subtotal: '100.00',
        total: '100.00',
      },
    ],
  }
}

/** `n` orders, one minute apart, oldest first. */
function fullPage(n: number, startId: number) {
  return Array.from({ length: n }, (_, i) =>
    wooOrder(startId + i, new Date(Date.UTC(2024, 0, 1, 0, startId + i)).toISOString().slice(0, 19)),
  )
}

/** `n` orders whose modified stamps ascend, as an incremental pull returns them. */
function fullModifiedPage(n: number, startId: number) {
  return Array.from({ length: n }, (_, i) => ({
    ...wooOrder(startId + i, new Date(Date.UTC(2024, 0, 1, 0, startId + i)).toISOString().slice(0, 19)),
    date_modified_gmt: new Date(Date.UTC(2026, 6, 1, 0, startId + i)).toISOString().slice(0, 19),
  }))
}

/** A mappable order that carries a discount code. */
function wooCouponOrder(id: number, placedAt: string, code: string) {
  return { ...wooOrder(id, placedAt), coupon_lines: [{ code }] }
}

async function connectedShop(name: string) {
  return db.shop.create({
    data: {
      name,
      currency: 'NOK',
      wooUrl: 'https://shop.example',
      wooKey: encryptSecret('ck_real'),
      wooSecret: encryptSecret('cs_real'),
    },
  })
}

describe('syncShop', () => {
  it('decrypts stored keys and syncs (0 orders is a fine sync)', async () => {
    const shop = await connectedShop('Sync [sync-test]')
    const fetchMock = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(true)
    expect(result.ordersSynced).toBe(0)

    // The decrypted key — not the enc:v1: blob — must reach WooCommerce.
    const auth = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('ck_real:cs_real').toString('base64')}`)

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).not.toBeNull()
  })

  it('reports unreadable keys as "reconnect", and never calls the store', async () => {
    const shop = await db.shop.create({
      data: {
        name: 'Sync bad key [sync-test]',
        currency: 'NOK',
        wooUrl: 'https://shop.example',
        wooKey: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        wooSecret: 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Reconnect this shop/)
    expect(fetchMock).not.toHaveBeenCalled()

    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull() // watermark untouched on failure
  })

  it('a big first sync stores a chunk and reports more, leaving the watermark unset', async () => {
    const shop = await connectedShop('Sync backfill [sync-test]')
    // One full page (the chunk limit for this test), so history is "behind it".
    const fetchMock = vi.fn().mockImplementation(async () => jsonPage(fullPage(100, 1)))
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id, { backfillPages: 1 })
    expect(result.ok).toBe(true)
    expect(result.more).toBe(true)
    expect(result.ordersSynced).toBe(100)

    // The chunk LANDED, but the shop is still mid-backfill: watermark stays unset
    // so the next press resumes instead of switching to incremental mode.
    expect(await db.order.count({ where: { shopId: shop.id } })).toBe(100)
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt).toBeNull()
  })

  it('the next press resumes just behind the newest stored order', async () => {
    const shop = await connectedShop('Sync resume [sync-test]')
    await db.order.create({
      data: {
        shopId: shop.id,
        externalId: 'resume-1',
        number: '1',
        placedAt: new Date('2024-06-01T12:00:00Z'),
        status: 'completed',
        currency: 'NOK',
        grossSales: 10000,
        discountTotal: 0,
        netSales: 10000,
        shippingCharged: 0,
        taxTotal: 2500,
        total: 12500,
      },
    })
    const fetchMock = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const before = Date.now()
    const result = await syncShop(shop.id)
    expect(result.ok).toBe(true)
    expect(result.more).toBeUndefined()

    // Resumes by CREATED date, one second behind the newest stored order so the
    // boundary order is re-fetched rather than risk being skipped.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('after=2024-06-01T11%3A59%3A59')
    expect(url).not.toContain('modified_after')

    // History complete: the watermark starts a day back, so anything edited
    // while the backfill ran is picked up by the first incremental sync.
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    const wm = saved.lastSyncAt!.getTime()
    expect(wm).toBeGreaterThan(before - 25 * 60 * 60 * 1000)
    expect(wm).toBeLessThan(before - 23 * 60 * 60 * 1000)
  })

  it('a completed sync refreshes catalog prices; a catalog failure never fails the sync', async () => {
    const shop = await connectedShop('Sync catalog [sync-test]')
    const prod = await db.product.create({
      data: { shopId: shop.id, externalId: '900001', sku: 'S', name: 'P [sync-test]', lastPrice: 100000 },
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown) =>
      String(url).includes('/products')
        ? jsonPage([{ id: 900001, price: '3790.00' }, { id: 999999, price: '10.00' }])
        : emptyPage(),
    ))

    expect((await syncShop(shop.id)).ok).toBe(true)
    const saved = await db.product.findUniqueOrThrow({ where: { id: prod.id } })
    expect(saved.catalogPrice).toBe(379000) // the store's incl-VAT price landed

    // Now the catalog endpoint dies — the sync itself still succeeds.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown) =>
      String(url).includes('/products') ? new Response('boom', { status: 500 }) : emptyPage(),
    ))
    expect((await syncShop(shop.id)).ok).toBe(true)
  })

  it('attributes the same code text to a different ambassador per store, never mixing them', async () => {
    // The client's real case: JOHN10 exists on both Norway and Sweden, meaning
    // two different people. A Norwegian order must never earn a Swedish John.
    const norway = await connectedShop('Attr NO [sync-test]')
    const sweden = await connectedShop('Attr SE [sync-test]')
    const johnN = await db.ambassador.create({
      data: {
        name: 'John Norway',
        email: 'john-no-[sync-test]@x.local',
        commissionRate: 0.1,
        codes: { create: { shopId: norway.id, code: 'SAME10' } },
      },
    })
    const johnS = await db.ambassador.create({
      data: {
        name: 'John Sweden',
        email: 'john-se-[sync-test]@x.local',
        commissionRate: 0.1,
        codes: { create: { shopId: sweden.id, code: 'SAME10' } },
      },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown) =>
      String(url).includes('/orders')
        ? jsonPage([wooCouponOrder(1, '2024-01-01T00:00:00', 'SAME10')])
        : emptyPage(),
    ))

    expect((await syncShop(norway.id)).ok).toBe(true)
    expect((await syncShop(sweden.id)).ok).toBe(true)

    const noOrder = await db.order.findFirstOrThrow({ where: { shopId: norway.id } })
    const seOrder = await db.order.findFirstOrThrow({ where: { shopId: sweden.id } })
    expect(noOrder.ambassadorId).toBe(johnN.id)
    expect(seOrder.ambassadorId).toBe(johnS.id)
  })

  it('an incremental pull reaches five minutes behind the watermark, so nothing at the boundary is missed', async () => {
    const shop = await connectedShop('Sync overlap [sync-test]')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T12:00:00Z') },
    })
    const fetchMock = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    expect((await syncShop(shop.id)).ok).toBe(true)

    // Woo is only told whole seconds and its clock may drift from ours; the
    // five-minute overlap makes both harmless, and the upserts make it free.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('modified_after=2026-07-01T11%3A55%3A00')
  })

  it('sets the watermark to when the fetch BEGAN, so an order changed mid-sync stays in the next window', async () => {
    const shop = await connectedShop('Sync watermark [sync-test]')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T12:00:00Z') },
    })
    // A slow store: every call takes over a second.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 1200))
        return emptyPage()
      }),
    )

    const before = Date.now()
    expect((await syncShop(shop.id)).ok).toBe(true)

    // The old bug: stamping completion time (here ≥ 2.4s later, after orders +
    // catalog calls) left everything changed DURING the sync outside every window.
    const saved = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(saved.lastSyncAt!.getTime()).toBeGreaterThanOrEqual(before - 50)
    expect(saved.lastSyncAt!.getTime()).toBeLessThan(before + 1000)
  })

  it('fills the customer on legacy orders without touching what they earned', async () => {
    const shop = await connectedShop('Sync cust [sync-test]')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T12:00:00Z') },
    })
    // Synced before customers existed: customerName is null, attribution frozen.
    const amb = await db.ambassador.create({
      data: { name: 'Frozen', email: 'frozen-[sync-test]@x.local', commissionRate: 0.1 },
    })
    const legacy = await db.order.create({
      data: {
        shopId: shop.id, externalId: '7001', number: '7001',
        placedAt: new Date('2026-05-01T10:00:00Z'), status: 'completed', currency: 'NOK',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 2500, total: 12500, ambassadorId: amb.id,
      },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url)
      if (u.includes('include=7001')) {
        return jsonPage([
          { ...wooOrder(7001, '2026-05-01T10:00:00'), billing: { first_name: 'Tino', last_name: 'Skaarup', email: 'tino@x.dk' } },
        ])
      }
      return emptyPage()
    }))

    expect((await syncShop(shop.id)).ok).toBe(true)

    const saved = await db.order.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(saved.customerName).toBe('Tino Skaarup')
    expect(saved.customerEmail).toBe('tino@x.dk')
    // ONLY the customer landed — the money and the attribution are history.
    expect(saved.ambassadorId).toBe(amb.id)
    expect(saved.netSales).toBe(10000)
  })

  it("marks an order Woo no longer has as 'checked, nothing there', so the backfill always finishes", async () => {
    const shop = await connectedShop('Sync cust gone [sync-test]')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T12:00:00Z') },
    })
    const legacy = await db.order.create({
      data: {
        shopId: shop.id, externalId: '7002', number: '7002',
        placedAt: new Date('2026-05-02T10:00:00Z'), status: 'completed', currency: 'NOK',
        grossSales: 10000, discountTotal: 0, netSales: 10000, shippingCharged: 0,
        taxTotal: 2500, total: 12500,
      },
    })
    // Woo answers the id lookup with nothing at all.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))

    expect((await syncShop(shop.id)).ok).toBe(true)

    // '' and not null: the order leaves the backfill queue for good.
    const saved = await db.order.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(saved.customerName).toBe('')
  })
})

describe('run bookkeeping', () => {
  it('records why a store failed, and leaves the watermark alone', async () => {
    const shop = await connectedShop('[sync-test] refuses')
    const watermark = new Date('2026-07-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 401 }),
    ))

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    // The window is retried unchanged, so the watermark must not move...
    expect(after.lastSyncAt?.toISOString()).toBe(watermark.toISOString())
    // ...but the attempt is on the record, with its reason.
    expect(after.lastError).toContain('401')
    expect(after.lastRunAt).not.toBeNull()
  })

  // A store that always fails must not hold the front of the queue forever.
  it('moves lastRunAt even when the attempt failed', async () => {
    const shop = await connectedShop('[sync-test] always fails')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2020-01-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await syncShop(shop.id)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastRunAt!.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime())
  })

  it('clears the error once the store answers again', async () => {
    const shop = await connectedShop('[sync-test] recovers')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastError: 'something old' },
    })

    // One empty page: nothing changed since the watermark, which is a success.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const result = await syncShop(shop.id)

    expect(result.ok).toBe(true)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastError).toBeNull()
    expect(after.lastRunAt).not.toBeNull()
  })

  it('records the reason when the saved keys cannot be read', async () => {
    const shop = await connectedShop('[sync-test] bad keys')
    // Ciphertext this deployment's AUTH_SECRET cannot open.
    await db.shop.update({
      where: { id: shop.id },
      data: { wooKey: 'enc:v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    })

    const result = await syncShop(shop.id)
    expect(result.ok).toBe(false)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastError).toContain('Reconnect')
    expect(after.lastRunAt).not.toBeNull()
  })
})

/**
 * A partial pull, bounded to one page.
 *
 * The bounding is not incidental. A mock returning full pages forever runs the
 * pull to its 50-page ceiling and `storeOrder` then writes 5,000 orders one at a
 * time — minutes per test. A partial pull is a partial pull whether it stopped
 * at page 2 or page 50, so one page proves the same thing.
 *
 * Bounded by `maxPages` rather than by a deadline on purpose: a deadline is set
 * before `syncShop` does its own database reads, so on a loaded machine it can
 * expire before the FIRST fetch and the test then proves nothing. `maxPages` is
 * the same test-only seam `backfillPages` already provides for the other path.
 */
const onePage = (body: unknown) => vi.fn().mockImplementation(async () => jsonPage(body))

describe('draining a backlog', () => {
  it('advances the watermark to the last order it processed', async () => {
    const shop = await connectedShop('[sync-test] backlog')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-06-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))

    const result = await syncShop(shop.id, { maxPages: 1 })

    // It is NOT a failure. It is progress with more to come.
    expect(result.ok).toBe(true)
    expect(result.more).toBe(true)

    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    // The exact stamp of the last order processed, not merely "later than
    // before": advancing to `now` would also satisfy an inequality, while
    // skipping every order between these 100 and the present.
    expect(after.lastSyncAt!.toISOString()).toBe('2026-07-01T01:39:00.000Z')
    expect(after.lastError).toBeNull()
  })

  it('resumes the next pull from where the last one stopped', async () => {
    const shop = await connectedShop('[sync-test] resumes')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-06-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))
    await syncShop(shop.id, { maxPages: 1 })

    // Second run: whatever it asks for is the proof there is no gap.
    const second = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', second)
    await syncShop(shop.id)

    // 01:39:00 minus the five-minute OVERLAP.
    expect(String(second.mock.calls[0][0])).toContain('modified_after=2026-07-01T01%3A34%3A00')
  })

  // The old behaviour: refuse, leave the watermark, and be handed a bigger
  // window next run. Forever.
  it('never returns the over-5,000 refusal again', async () => {
    const shop = await connectedShop('[sync-test] no refusal')
    await db.shop.update({
      where: { id: shop.id },
      data: { lastSyncAt: new Date('2026-06-01T00:00:00Z') },
    })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))

    const result = await syncShop(shop.id, { maxPages: 1 })
    expect(result.error ?? '').not.toContain('5,000')
    expect(result.ok).toBe(true)
    expect(result.more).toBe(true)
  })

  // Advancing to the last row of an unsorted result would skip everything the
  // store did not happen to return.
  it('refuses to advance when the store ignored the ordering', async () => {
    const shop = await connectedShop('[sync-test] unsorted')
    const watermark = new Date('2026-06-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    // Full page, modified stamps descending — the opposite of what we asked.
    // The guard only matters on a PARTIAL pull: a completed one moves its
    // watermark to the fetch time and needs no resume point, so this must stop
    // early to be testing anything at all.
    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0).reverse()))

    const result = await syncShop(shop.id, { maxPages: 1 })

    expect(result.ok).toBe(false)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastError).toContain('modified date')
  })

  // The deadline expired before a single page came back: nothing was stored, so
  // there is nowhere to advance to. The attempt still counts as attention paid.
  it('leaves the watermark alone when nothing arrived', async () => {
    const shop = await connectedShop('[sync-test] no time')
    const watermark = new Date('2026-06-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncShop(shop.id, { deadline: Date.now() - 1 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastRunAt).not.toBeNull()
  })

  // A burst of orders sharing one moment can leave the resume point BEHIND
  // where we started: more changed in one instant than one run can carry.
  // Writing that watermark would pin (or rewind) the window, refetching the
  // same page forever — a standstill, not a skip, but it must not be reported
  // as success.
  it('refuses to advance when the resume point cannot clear the overlap', async () => {
    const shop = await connectedShop('[sync-test] stalled')
    // After the fixture's newest stamp (01:39:00), so the resume point this
    // pull produces lands BEHIND this watermark instead of ahead of it.
    const watermark = new Date('2026-07-01T02:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    vi.stubGlobal('fetch', onePage(fullModifiedPage(100, 0)))

    const result = await syncShop(shop.id, { maxPages: 1 })

    expect(result.ok).toBe(false)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastError).toContain('cannot move past')
  })

  // An unparseable stamp is not a resume point. Left unflagged this is the
  // silent freeze the branch exists to remove: no advance, no error, and a
  // page that says "Catching up" forever.
  it('stops and explains itself when the resume stamp cannot be parsed', async () => {
    const shop = await connectedShop('[sync-test] unreadable stamp')
    const watermark = new Date('2026-06-01T00:00:00Z')
    await db.shop.update({ where: { id: shop.id }, data: { lastSyncAt: watermark } })

    // A full page, genuinely sorted ascending, but the LAST stamp — the one
    // that would become the resume point — is garbage a plugin might send.
    const orders = fullModifiedPage(100, 0)
    orders[orders.length - 1].date_modified_gmt = 'not-a-real-date'
    vi.stubGlobal('fetch', onePage(orders))

    const result = await syncShop(shop.id, { maxPages: 1 })

    expect(result.ok).toBe(false)
    const after = await db.shop.findUniqueOrThrow({ where: { id: shop.id } })
    expect(after.lastSyncAt!.toISOString()).toBe(watermark.toISOString())
    expect(after.lastError).toContain('could not read')
  })
})

describe('voidedAt', () => {
  let shopId: string
  beforeEach(async () => {
    shopId = (await connectedShop('Sync voided [sync-test]')).id
  })

  // Shadows the outer, positional wooOrder(id, placedAt) for this block only:
  // these tests care about status transitions, not dates, and need a builder
  // that takes an object with `id` and `status`. The file has no such builder.
  /** Minimal, mappable WooCommerce order: only id and status vary. */
  function wooOrder({ id, status }: { id: number; status: string }) {
    return {
      id,
      number: String(id),
      status,
      currency: 'NOK',
      date_created_gmt: '2026-07-01T00:00:00',
      discount_total: '0.00',
      discount_tax: '0.00',
      shipping_total: '0.00',
      shipping_tax: '0.00',
      total_tax: '0.00',
      total: '0.00',
      coupon_lines: [],
      line_items: [],
    }
  }

  it('stamps when an order we already hold becomes refunded', async () => {
    await storeOrder(shopId, wooOrder({ id: 7001, status: 'completed' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7001' } })).voidedAt).toBeNull()

    await storeOrder(shopId, wooOrder({ id: 7001, status: 'refunded' }), new Map())
    const after = await db.order.findFirstOrThrow({ where: { externalId: '7001' } })
    expect(after.voidedAt).toBeInstanceOf(Date)
  })

  it('does NOT stamp an order that arrives already refunded', async () => {
    // A first sync, a backfill, a newly connected store. We do not know when
    // it was refunded, and a guessed date would put a reversal on a wrong day.
    await storeOrder(shopId, wooOrder({ id: 7002, status: 'refunded' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7002' } })).voidedAt).toBeNull()
  })

  it('does not move the stamp when a refunded order is seen again', async () => {
    await storeOrder(shopId, wooOrder({ id: 7003, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7003, status: 'refunded' }), new Map())
    const first = (await db.order.findFirstOrThrow({ where: { externalId: '7003' } })).voidedAt

    await storeOrder(shopId, wooOrder({ id: 7003, status: 'refunded' }), new Map())
    const second = (await db.order.findFirstOrThrow({ where: { externalId: '7003' } })).voidedAt
    expect(second?.getTime()).toBe(first?.getTime())
  })

  it('clears the stamp if the store un-refunds an order', async () => {
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'refunded' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7004, status: 'completed' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7004' } })).voidedAt).toBeNull()
  })

  it('does not stamp an unpaid order — pending is not a refund', async () => {
    await storeOrder(shopId, wooOrder({ id: 7005, status: 'completed' }), new Map())
    await storeOrder(shopId, wooOrder({ id: 7005, status: 'on-hold' }), new Map())
    expect((await db.order.findFirstOrThrow({ where: { externalId: '7005' } })).voidedAt).toBeNull()
  })
})

describe('rotation', () => {
  it('serves the longest-ignored store first', async () => {
    const fresh = await connectedShop('[sync-test] rot fresh')
    const stale = await connectedShop('[sync-test] rot stale')
    await db.shop.update({
      where: { id: fresh.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-31T00:00:00Z') },
    })
    await db.shop.update({
      where: { id: stale.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-02T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const results = await syncAllShops()

    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] rot'))
    expect(ours[0].shopName).toBe('[sync-test] rot stale')
  })

  // Never run = most stale of all, and Postgres sorts nulls LAST by default.
  it('puts a never-run store at the very front', async () => {
    const never = await connectedShop('[sync-test] rot never')
    expect(never.lastRunAt).toBeNull() // the precondition this test rests on
    const ran = await connectedShop('[sync-test] rot ran')
    await db.shop.update({
      where: { id: ran.id },
      data: { lastSyncAt: new Date('2026-07-01T00:00:00Z'), lastRunAt: new Date('2026-07-02T00:00:00Z') },
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => emptyPage()))
    const results = await syncAllShops()

    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] rot'))
    expect(ours[0].shopName).toBe('[sync-test] rot never')
  })

  it('starts no store once the deadline has passed', async () => {
    await connectedShop('[sync-test] deadline a')
    await connectedShop('[sync-test] deadline b')

    const fetchMock = vi.fn().mockImplementation(async () => emptyPage())
    vi.stubGlobal('fetch', fetchMock)

    const results = await syncAllShops({ deadline: Date.now() - 1 })

    expect(results.filter((r) => r.shopName.startsWith('[sync-test] deadline'))).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // One store failing must never cost the stores behind it their turn.
  it('carries on to the next store after one fails', async () => {
    await connectedShop('[sync-test] pair one')
    await connectedShop('[sync-test] pair two')

    let call = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      call++
      return call === 1 ? new Response('down', { status: 500 }) : emptyPage()
    }))

    const results = await syncAllShops()
    const ours = results.filter((r) => r.shopName.startsWith('[sync-test] pair'))
    expect(ours).toHaveLength(2)
    expect(ours.some((r) => r.ok)).toBe(true)
  })
})
