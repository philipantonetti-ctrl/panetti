import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTracking, requestBudgetMs, RATE_LIMIT_GAP_MS } from './client'

const KEY = 'test-api-key'

const ok = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('requestBudgetMs', () => {
  it('uses the ceiling when the caller set no deadline', () => {
    expect(requestBudgetMs({})).toBe(30_000)
  })

  it('shortens to whatever is left of the run', () => {
    expect(requestBudgetMs({ deadline: 5_000 }, 0)).toBe(5_000)
  })

  it('never returns a budget a timeout would reject', () => {
    // An expired budget still has to be a valid timeout. It is the caller's
    // loop that stops, not this.
    expect(requestBudgetMs({ deadline: 0 }, 10_000)).toBe(1)
  })
})

describe('fetchTracking', () => {
  it('sends the key in the header DHL expects', async () => {
    const fetchMock = ok({ shipments: [] })
    vi.stubGlobal('fetch', fetchMock)

    await fetchTracking(KEY, '9599861672')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('trackingNumber=9599861672')
    // Not Authorization, not x-api-key. DHL rejects anything else with a 401.
    expect(init.headers['DHL-API-Key']).toBe(KEY)
  })

  it('returns the body for a parcel DHL knows', async () => {
    vi.stubGlobal('fetch', ok({ shipments: [{ id: '9599861672' }] }))
    const body = await fetchTracking(KEY, '9599861672')
    expect(body).toEqual({ shipments: [{ id: '9599861672' }] })
  })

  /**
   * A 404 is DHL saying "no shipment with that number", which is an ordinary
   * answer for a parcel the warehouse has booked but not yet handed over. It is
   * the caller's job to decide what that means, so it must not throw.
   */
  it('reads a 404 as “not known yet”, not as a failure', async () => {
    vi.stubGlobal('fetch', ok({ status: 404, title: 'No result found' }, 404))
    expect(await fetchTracking(KEY, 'nope')).toBeNull()
  })

  it('throws on a rejected key, so the run records why nothing worked', async () => {
    vi.stubGlobal('fetch', ok({ status: 401, title: 'Unauthorized' }, 401))
    await expect(fetchTracking(KEY, '1')).rejects.toThrow(/401/)
  })

  it('throws on a rate limit rather than pretending the parcel is unknown', async () => {
    // 429 and 404 must never be confused: one means slow down, the other means
    // the number is not live yet. Treating 429 as "unknown" would push the
    // parcel into the six-hour tier and quietly lose a day of tracking.
    vi.stubGlobal('fetch', ok({ status: 429 }, 429))
    await expect(fetchTracking(KEY, '1')).rejects.toThrow(/429/)
  })

  it('truncates an error body, so a gateway’s HTML page never fills a log line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'x'.repeat(5_000) }),
    )
    await expect(fetchTracking(KEY, '1')).rejects.toThrow(/^DHL responded 500: x{300}$/)
  })

  it('spaces calls far enough apart for DHL’s one-every-five-seconds limit', () => {
    // The free tier allows 250 calls a day at no more than one every 5 seconds.
    // The poller sleeps by this between parcels.
    expect(RATE_LIMIT_GAP_MS).toBeGreaterThanOrEqual(5_000)
  })
})
