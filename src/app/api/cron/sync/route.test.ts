import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The real stores are never called here; we test the guard and the reporting.
const syncAllShops = vi.fn()
vi.mock('@/lib/woo/sync', () => ({ syncAllShops: (...args: unknown[]) => syncAllShops(...args) }))

// Nor is the real currency API: the route tops up FX rates best-effort after a
// sync, and a unit test must not depend on a third-party service being up.
vi.mock('@/lib/fx/rates', () => ({ ensureRates: vi.fn() }))

const { GET } = await import('./route')

const call = (auth?: string) =>
  GET(
    new Request('http://localhost/api/cron/sync', {
      headers: auth ? { authorization: auth } : {},
    }),
  )

const REAL = process.env.CRON_SECRET

beforeEach(() => {
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
  // A route nothing ever calls is not an automatic sync. Every 15 minutes:
  // webhooks carry the live changes, this is the promised safety net.
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
