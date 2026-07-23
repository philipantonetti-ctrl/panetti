import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The real stores are never called here; we test the guard and the reporting.
const syncAllShops = vi.fn()
vi.mock('@/lib/woo/sync', () => ({ syncAllShops: () => syncAllShops() }))

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
})

describe('the schedule itself', () => {
  // A route nothing ever calls is not an automatic sync.
  it('is registered as an hourly cron in vercel.json', async () => {
    const { readFileSync } = await import('fs')
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'))
    expect(cfg.crons).toEqual([{ path: '/api/cron/sync', schedule: '0 * * * *' }])
  })
})
