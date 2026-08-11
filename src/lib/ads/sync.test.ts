import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { syncAdAccount, syncAllAdAccounts, syncWindow } from './sync'

/**
 * DB-backed: rows live in the shared local test database, scoped by the
 * [ads-test] marker so parallel test files never collide.
 */

const MARKER = '[ads-test]'
const DAY_MS = 24 * 60 * 60 * 1000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function wipe() {
  await db.adAccount.deleteMany({ where: { name: { contains: MARKER } } })
  await db.adConnection.deleteMany({ where: { label: { contains: MARKER } } })
  await db.shop.deleteMany({ where: { name: { contains: MARKER } } })
}

async function makeAccount(over: Record<string, unknown> = {}) {
  const shop = await db.shop.create({ data: { name: `${MARKER} shop`, currency: 'NOK' } })
  return db.adAccount.create({
    data: {
      shopId: shop.id,
      provider: 'meta',
      externalId: `ads-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${MARKER} account`,
      currency: 'NOK',
      credentials: JSON.stringify({ accessToken: 'plain' }),
      ...over,
    },
  })
}

beforeEach(wipe)
afterEach(async () => {
  await wipe()
  vi.unstubAllGlobals()
})

describe('syncWindow', () => {
  it('backfills a year on first sync, and covers the restate window after that', () => {
    const now = new Date('2026-07-29T10:00:00Z')
    const first = syncWindow(null, now)
    expect(first.to).toEqual(new Date('2026-07-29T00:00:00Z'))
    expect((first.to.getTime() - first.from.getTime()) / DAY_MS).toBe(365)

    // Synced yesterday: one day of gap plus the 35-day restate window. The
    // extra day costs nothing — every write is an upsert keyed on (account, date).
    const later = syncWindow(new Date('2026-07-28T00:00:00Z'), now)
    expect((later.to.getTime() - later.from.getTime()) / DAY_MS).toBe(36)
  })

  it('reaches back to the last successful sync, not a fixed 35 days', () => {
    // A token expired on 11 June and nobody noticed until 10 August. The
    // account kept its old lastSyncAt while it errored, which is correct.
    // What is not correct is fetching only 35 days on recovery and then
    // stamping lastSyncAt = now: days 36-60 are then never fetched by
    // anything, ever, and the hole is sealed silently.
    const now = new Date('2026-08-10T10:00:00Z')
    const stale = syncWindow(new Date('2026-06-11T00:00:00Z'), now)

    // 60 days of gap plus the 35-day restate window.
    expect((stale.to.getTime() - stale.from.getTime()) / DAY_MS).toBe(95)

    // The point of the number: the day after the last sync is inside the window.
    expect(stale.from.getTime()).toBeLessThan(new Date('2026-06-12T00:00:00Z').getTime())
  })

  it('caps a very stale account at the backfill limit rather than asking for ten years', () => {
    const now = new Date('2026-08-10T10:00:00Z')
    const ancient = syncWindow(new Date('2024-01-01T00:00:00Z'), now)
    expect((ancient.to.getTime() - ancient.from.getTime()) / DAY_MS).toBe(365)
  })

  it('floors at the restate window when lastSyncAt is in the future', () => {
    // Clock skew between the app server and the database must not produce a
    // negative window that fetches nothing.
    const now = new Date('2026-08-10T10:00:00Z')
    const skewed = syncWindow(new Date('2026-08-20T00:00:00Z'), now)
    expect((skewed.to.getTime() - skewed.from.getTime()) / DAY_MS).toBe(35)
  })
})

describe('syncAdAccount', () => {
  it('stores daily rows and overwrites them in place on the next run', async () => {
    const account = await makeAccount()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json({ data: [{ date_start: '2026-07-01', spend: '100.00', impressions: '10', clicks: '2' }] }),
      ),
    )

    const first = await syncAdAccount(account)
    expect(first).toMatchObject({ ok: true, days: 1 })

    // Meta restated the day upward: same row, new numbers, still one row.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        json({ data: [{ date_start: '2026-07-01', spend: '150.00', impressions: '15', clicks: '3' }] }),
      ),
    )
    await syncAdAccount({ ...account, lastSyncAt: new Date() })

    const rows = await db.adSpend.findMany({ where: { accountId: account.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].spend).toBe(15000)

    const fresh = await db.adAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastSyncAt).not.toBeNull()
    expect(fresh.lastError).toBeNull()
  })

  it('stores the failure on the account instead of throwing', async () => {
    const account = await makeAccount()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: 'Invalid OAuth access token' } }, 401)),
    )

    const result = await syncAdAccount(account)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Invalid OAuth access token')

    const fresh = await db.adAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastError).toBe('Invalid OAuth access token')
  })
})

describe('daily budgets', () => {
  it('refreshes the budget alongside the spend', async () => {
    const account = await makeAccount()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/campaigns'))
          return json({ data: [{ daily_budget: '80000', effective_status: 'ACTIVE' }] })
        return json({ data: [{ date_start: '2026-07-01', spend: '10.00', impressions: '1', clicks: '1' }] })
      }),
    )

    expect((await syncAdAccount(account)).ok).toBe(true)
    const fresh = await db.adAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.dailyBudget).toBe(80000)
  })

  it('a failed budget answer keeps the old number and the sync green', async () => {
    const account = await makeAccount({ dailyBudget: 55555 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/campaigns')) return json({ error: { message: 'nope' } }, 500)
        return json({ data: [] })
      }),
    )

    expect((await syncAdAccount(account)).ok).toBe(true)
    const fresh = await db.adAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.dailyBudget).toBe(55555)
    expect(fresh.lastError).toBeNull()
  })
})

describe('connection-backed accounts', () => {
  it('syncs with the login token instead of pasted credentials', async () => {
    const shop = await db.shop.create({ data: { name: `${MARKER} conn shop`, currency: 'NOK' } })
    const connection = await db.adConnection.create({
      data: { provider: 'meta', label: `${MARKER} login`, secret: 'conn-token' },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id,
        provider: 'meta',
        externalId: `conn-${Date.now()}`,
        name: `${MARKER} connected`,
        currency: 'NOK',
        credentials: null,
        connectionId: connection.id,
      },
    })

    const fetchMock = vi.fn().mockImplementation(async () =>
      json({ data: [{ date_start: '2026-07-01', spend: '10.00', impressions: '1', clicks: '1' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncAdAccount({ ...account, connection })
    expect(result.ok).toBe(true)
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer conn-token')
  })

  it('an expired Facebook token becomes a readable error, not a crash', async () => {
    const shop = await db.shop.create({ data: { name: `${MARKER} exp shop`, currency: 'NOK' } })
    const connection = await db.adConnection.create({
      data: {
        provider: 'meta',
        label: `${MARKER} old login`,
        secret: 'old',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    const account = await db.adAccount.create({
      data: {
        shopId: shop.id,
        provider: 'meta',
        externalId: `exp-${Date.now()}`,
        name: `${MARKER} expired`,
        currency: 'NOK',
        credentials: null,
        connectionId: connection.id,
      },
    })

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await syncAdAccount({ ...account, connection })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Facebook login expired')
    expect(fetchMock).not.toHaveBeenCalled()

    const fresh = await db.adAccount.findUniqueOrThrow({ where: { id: account.id } })
    expect(fresh.lastError).toContain('Facebook login expired')
  })
})

describe('syncAllAdAccounts', () => {
  it('skips a freshly synced account unless forced', async () => {
    await makeAccount({ lastSyncAt: new Date(Date.now() - 60 * 60 * 1000) }) // 1h ago
    const fetchMock = vi.fn().mockImplementation(async () => json({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    // Scoped assertion: other suites' accounts may exist, so only count ours.
    const idle = await syncAllAdAccounts()
    expect(idle.filter((r) => r.name.includes(MARKER))).toHaveLength(0)

    const forced = await syncAllAdAccounts({ force: true })
    expect(forced.filter((r) => r.name.includes(MARKER))).toHaveLength(1)
  })
})
