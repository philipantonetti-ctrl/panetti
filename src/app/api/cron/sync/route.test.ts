import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The real stores are never called here; we test the guard and the reporting.
const syncAllShops = vi.fn()
vi.mock('@/lib/woo/sync', () => ({ syncAllShops: (...args: unknown[]) => syncAllShops(...args) }))

// Nor is the helpdesk. Same trap as Visma below: with GORGIAS_* set in .env
// the route really does reach the CLIENT'S LIVE Gorgias account, and the
// import paces itself a second per page, so an unmocked run here both spends
// their rate limit and blows the test timeout.
const syncSupport = vi.fn(async () => ({
  configured: false, stored: 0, backfilling: false, oldestSeenAt: null, error: null,
}))
vi.mock('@/lib/support/sync', () => ({ syncSupport: () => syncSupport() }))

// Nor is the real currency API: the route tops up FX rates best-effort after a
// sync, and a unit test must not depend on a third-party service being up.
vi.mock('@/lib/fx/rates', () => ({ ensureRates: vi.fn() }))

// Nor is Visma. This one is not merely slow, it is the CLIENT'S LIVE ERP - and
// without this mock the test really does reach it, because the route sees the
// VISMA_* credentials from .env even though a plain unit test does not. Left
// unmocked it read 719 real order lines and wrote 62 rows into the local
// database, taking 39 seconds to do it.
const importVismaPurchaseOrders = vi.fn(async () => ({
  configured: false, read: 0, imported: 0, skipped: [], truncated: false, error: null,
}))
const importVismaB2bSales = vi.fn(async (opts?: { deadline?: number }) => ({
  configured: true, linked: 2, read: 40, imported: 3,
  skipped: [{ reason: 'not a linked customer', count: 37 }],
  // Honours the deadline the way the real one does, so a route that forgot to
  // pass a usable one cannot look identical to a route that passed a good one.
  partial: opts?.deadline !== undefined && Date.now() > opts.deadline,
  error: null,
}))
vi.mock('@/lib/visma/import', () => ({
  importVismaPurchaseOrders: () => importVismaPurchaseOrders(),
  // Arguments forwarded, not dropped: the deadline this route hands it is the
  // only thing keeping a request-per-customer read inside the platform ceiling.
  importVismaB2bSales: (...args: [{ deadline?: number }?]) => importVismaB2bSales(...args),
}))

// Nor Bring's invoice archive. Left unmocked, this reaches Bring's real API
// and writes real rows into the shared local database the moment any
// developer's local DeliveryConfig singleton happens to hold Bring
// credentials - it only looks harmless today because that row is usually
// empty. Same shape as the Visma mock above, and for the same reason.
const syncBringInvoices = vi.fn(async (opts?: { deadline?: number }) => ({
  configured: false, found: 0, queued: 0, noSpec: 0,
  // Honours the deadline the way the real one does, so a route that forgot to
  // pass a usable one cannot look identical to a route that passed a good
  // one - same technique as importVismaB2bSales's mock above.
  partial: opts?.deadline !== undefined && Date.now() > opts.deadline,
  requested: false, stored: 0, unmatched: 0, error: null,
}))
vi.mock('@/lib/bring/invoice-sync', () => ({
  syncBringInvoices: (...args: [{ deadline?: number }?]) => syncBringInvoices(...args),
}))

const { GET } = await import('./route')

const call = (auth?: string) =>
  GET(
    new Request('http://localhost/api/cron/sync', {
      headers: auth ? { authorization: auth } : {},
    }),
  )

const REAL = process.env.CRON_SECRET

beforeEach(() => {
  importVismaB2bSales.mockClear()
  importVismaPurchaseOrders.mockClear()
  syncBringInvoices.mockClear()
  syncAllShops.mockReset()
  syncAllShops.mockResolvedValue([
    { shopId: 's1', shopName: 'Panetti Norway', ok: true, ordersSynced: 3 },
    { shopId: 's2', shopName: 'Panetti Sweden', ok: true, ordersSynced: 2 },
  ])
})

afterEach(() => {
  if (REAL === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = REAL
})

describe('the scheduled sync endpoint', () => {
  // An open sync endpoint would let a stranger hammer the client's WooCommerce
  // stores, so with nothing configured it must refuse rather than stand open.
  it('refuses to run at all when no secret is configured', async () => {
    delete process.env.CRON_SECRET
    const res = await call('Bearer anything')
    expect(res.status).toBe(503)
    expect(syncAllShops).not.toHaveBeenCalled()
  })

  it('refuses a caller that does not carry the secret', async () => {
    process.env.CRON_SECRET = 'right-secret'
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong-secret')).status).toBe(401)
    expect(syncAllShops).not.toHaveBeenCalled()
  })

  it('syncs every shop and reports what came in', async () => {
    process.env.CRON_SECRET = 'right-secret'
    const res = await call('Bearer right-secret')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, shops: 2, ordersSynced: 5, failed: [] })
    expect(syncAllShops).toHaveBeenCalledTimes(1)
  })

  // A half-failed run that reports success would hide stale figures.
  it('names the shops that failed instead of claiming success', async () => {
    process.env.CRON_SECRET = 'right-secret'
    syncAllShops.mockResolvedValue([
      { shopId: 's1', shopName: 'Panetti Norway', ok: true, ordersSynced: 3 },
      { shopId: 's2', shopName: 'Panetti Sweden', ok: false, ordersSynced: 0, error: 'store down' },
    ])

    const body = await (await call('Bearer right-secret')).json()
    expect(body.ok).toBe(false)
    expect(body.failed).toEqual(['Panetti Sweden'])
    expect(body.ordersSynced).toBe(3)
  })

  // This whole outage was one constant: maxDuration 60 while the platform
  // default is 300, so the run was killed four fifths of the way early and the
  // stores it never reached stayed frozen. Nobody re-caps it by accident.
  it('claims the full platform duration, never less', async () => {
    const { maxDuration } = await import('./route')
    expect(maxDuration).toBe(300)
  })

  /**
   * The B2B sales import runs on this schedule too, and its counts have to be
   * visible: `linked` is the difference between "nobody has linked a customer
   * yet" and "the import is broken", and the skip reasons are what would show a
   * webshop house account starting to be treated as a sale - the one failure
   * here that silently doubles revenue.
   */
  it('imports B2B sales and reports what it did, per reason', async () => {
    process.env.CRON_SECRET = 'right-secret'
    const body = await (await call('Bearer right-secret')).json()

    expect(importVismaB2bSales).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({
      b2bSalesLinked: 2,
      b2bSalesImported: 3,
      b2bSalesPartial: false,
      b2bSalesError: null,
    })
    expect(body.b2bSalesSkipped).toEqual([{ reason: 'not a linked customer', count: 37 }])
  })

  /**
   * ORDER IS A DECISION HERE, NOT AN ACCIDENT. One run makes roughly nine Visma
   * calls back to back, and the spec's own measurement is that about ten quick
   * calls earn a 429 which then holds for minutes. Whichever import goes last
   * meets the empty end of that window - and because the call order is fixed
   * and the preceding calls are identical every run, it loses the SAME
   * customers every time, importing nothing while every gate stays green.
   *
   * B2B sales goes first because it is the smallest and most bounded read of
   * the four, and because it is the only one whose absence produces a WRONG
   * revenue picture rather than a stale operational one: stock and purchase
   * orders can be a quarter of an hour out of date without misleading anyone
   * about money.
   */
  it('reads B2B sales before the other Visma imports, not last into a spent rate limit', async () => {
    process.env.CRON_SECRET = 'right-secret'
    await call('Bearer right-secret')

    expect(importVismaB2bSales.mock.invocationCallOrder[0])
      .toBeLessThan(importVismaPurchaseOrders.mock.invocationCallOrder[0])
  })

  /**
   * It starts after the shops may already have spent 240 of the 300 seconds,
   * and it makes one request per linked customer. Unbounded, a slow ERP at the
   * 60-second request timeout, once across every customer the client links, would
   * run past the platform ceiling and kill the parcel poll and the delivery
   * alert that follow it.
   */
  it('bounds the B2B sales import inside the function ceiling', async () => {
    process.env.CRON_SECRET = 'shhh'
    const before = Date.now()
    await call('Bearer shhh')

    const [opts] = importVismaB2bSales.mock.calls[0] as [{ deadline: number }]
    expect(opts.deadline).toBeGreaterThan(before)
    // Comfortably under maxDuration, and before the parcel poll's own budget so
    // the greedy stage after it is not starved.
    expect(opts.deadline).toBeLessThan(before + 275_000)
  })

  /**
   * I3: this is the only thing keeping the Bring invoice stage inside the
   * platform ceiling ahead of the parcel poll and the delivery alert - see
   * BRING_INVOICES_DEADLINE_MS's own comment in route.ts. Pinned to the exact
   * window between it (270_000) and SHIPMENTS_DEADLINE_MS (275_000) that
   * follows it, so a refactor that drops the deadline, or widens it into the
   * next stage's margin, fails this test rather than staying silent.
   */
  it('bounds the Bring invoice sync inside the function ceiling', async () => {
    process.env.CRON_SECRET = 'shhh'
    const before = Date.now()
    await call('Bearer shhh')

    const [opts] = syncBringInvoices.mock.calls[0] as [{ deadline: number }]
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 270_000)
    expect(opts.deadline).toBeLessThan(before + 275_000)
  })

  // Best-effort like every stage after the shops: the ERP having a bad morning
  // must never take the store sync down with it.
  it('survives the B2B sales import failing outright', async () => {
    process.env.CRON_SECRET = 'right-secret'
    importVismaB2bSales.mockRejectedValueOnce(new Error('ERP down'))

    const body = await (await call('Bearer right-secret')).json()

    expect(body.ok).toBe(true)
    expect(body.b2bSalesImported).toBe(0)
  })

  // Without a deadline the run keeps starting stores until the platform kills
  // it mid-store, which is the shape of the original bug.
  it('bounds the stores well inside the function ceiling', async () => {
    process.env.CRON_SECRET = 'shhh'
    const before = Date.now()
    await call('Bearer shhh')

    const [opts] = syncAllShops.mock.calls[0] as [{ deadline: number }]
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 240_000)
    // Comfortably under maxDuration, leaving room for the ads and rates after.
    expect(opts.deadline).toBeLessThan(before + 300_000)
  })
})

describe('the schedule itself', () => {
  // A route nothing ever calls is not an automatic sync. Every 15 minutes,
  // which never lets Neon sleep - measured 2026-08-28 as around 84 compute
  // hours a month, more than the Free plan's 100 allowed, which is why this
  // briefly ran hourly. The account is on a paid plan now and the owner chose
  // freshness over the saving, so 15 minutes is a decision, not an accident.
  // Webhooks carry the live order changes; this is the safety net behind them.
  it('is registered as a 15-minute cron in vercel.json', async () => {
    const { readFileSync } = await import('fs')
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'))
    // The briefing runs on its OWN route on its own schedule, not as a stage
    // in this one: this run is budgeted tight against the 300s ceiling, and
    // an unbounded model call ahead of the delivery alert it cannot afford to
    // starve (see this file's own comments) is exactly the risk that avoids.
    // Pinned as the whole array, not toContainEqual, so this still notices a
    // third cron appearing or the briefing cron disappearing.
    expect(cfg.crons).toEqual([
      { path: '/api/cron/sync', schedule: '*/15 * * * *' },
      { path: '/api/cron/briefing', schedule: '0 5 * * *' },
    ])
  })
})
