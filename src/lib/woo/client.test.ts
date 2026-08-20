import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchCatalog, fetchCoupons, fetchOrderStatuses, fetchOrders, requestBudgetMs } from './client'

const CREDS = { url: 'https://shop.example', key: 'ck', secret: 'cs' }

const couponsPage = (codes: string[]) =>
  new Response(JSON.stringify(codes.map((code, i) => ({ id: i, code }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

function page(n: number) {
  return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const statusPage = (rows: unknown[]) =>
  new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => vi.unstubAllGlobals())

describe('fetchOrders', () => {
  it('collects pages until a short one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(37))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, {})
    expect(orders).toHaveLength(137)
    expect(hasMore).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops at maxPages and says more is behind', async () => {
    // A fresh Response per call — a Response body can only be read once, and
    // mockResolvedValue would replay the exact same (already-consumed) instance.
    const fetchMock = vi.fn().mockImplementation(async () => page(100))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, { maxPages: 3 })
    expect(orders).toHaveLength(300)
    expect(hasMore).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // never a 4th request
  })

  it('filters by modified date for incremental syncs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('modified_after=2026-07-01T10%3A00%3A00')
    expect(url).not.toContain('after=2026-07-01T10%3A00%3A00&') // no created filter
  })

  it('filters by created date for first-sync chunks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { createdAfter: new Date('2024-01-29T00:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('after=2024-01-29T00%3A00%3A00')
    expect(url).not.toContain('modified_after')
  })

  // Truncating a modified-filtered list that is sorted by CREATED date leaves
  // nowhere safe to resume from, which is why the old code could only refuse.
  it('sorts incremental pulls by modified date, ascending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=modified')
    expect(url).toContain('order=asc')
  })

  // Without this the store reads our UTC timestamp as its own local time. A
  // store at UTC+2 then hands back a two-hour-wider window on every sync.
  it('tells the store our dates are GMT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') })

    expect(String(fetchMock.mock.calls[0][0])).toContain('dates_are_gmt=true')
  })

  // A first sync walks history forwards by creation date and resumes on it.
  it('leaves first-sync chunks sorted by created date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T10:00:00Z') })

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('orderby=date')
    expect(url).not.toContain('orderby=modified')
  })

  // The guard that stops a future call site inside this loop being added
  // without a timeout — one unresponsive store must never spend the budget of
  // every store waiting behind it.
  it('gives every request a signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, {})

    const opts = fetchMock.mock.calls[0][1] as RequestInit
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('fetchCoupons', () => {
  it('returns the store coupon codes, uppercased and deduped', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => couponsPage(['john10', 'JOHN10', 'summer']))
    vi.stubGlobal('fetch', fetchMock)

    const codes = await fetchCoupons(CREDS)
    expect(codes.sort()).toEqual(['JOHN10', 'SUMMER'])

    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/wp-json/wc/v3/coupons')
  })

  it('pages until a short page and stops', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => couponsPage(Array.from({ length: 100 }, (_, i) => `C${i}`)))
      .mockImplementationOnce(async () => couponsPage(['LAST']))
    vi.stubGlobal('fetch', fetchMock)

    const codes = await fetchCoupons(CREDS)
    expect(codes).toContain('LAST')
    expect(codes).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the store rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    await expect(fetchCoupons(CREDS)).rejects.toThrow(/401/)
  })
})

describe('bounded pulls', () => {
  // A store that never answers must cost this run, not every run behind it.
  it('stops before a fetch once the deadline has passed', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => page(100))
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline: Date.now() - 1,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(orders).toHaveLength(0)
    // Nothing was read, so there is certainly more.
    expect(hasMore).toBe(true)
  })

  it('stops between pages when the deadline arrives mid-pull', async () => {
    const deadline = Date.now() + 40
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30))
      return page(100)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
      deadline,
    })

    expect(hasMore).toBe(true)
    // Far fewer than the 50-page ceiling: it stopped on time, not on the cap.
    expect(fetchMock.mock.calls.length).toBeLessThan(5)
  })

  it('gives one request the lesser of the ceiling and what is left', () => {
    const now = 1_000_000
    // Plenty of deadline left: the ceiling wins.
    expect(requestBudgetMs({ deadline: now + 90_000 }, now)).toBe(30_000)
    // Nearly out of deadline: what is left wins.
    expect(requestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
    // No deadline at all: the ceiling.
    expect(requestBudgetMs({}, now)).toBe(30_000)
    // Never zero or negative — an already-expired budget must still be a valid
    // timeout, and the page loop is what actually stops.
    expect(requestBudgetMs({ deadline: now - 10_000 }, now)).toBe(1)
  })

  // requestBudgetMs deliberately leaves the LAST request only whatever time is
  // left of the deadline — sometimes a couple hundred ms — so a timeout here is
  // this clamp's NORMAL outcome. Discarding the pages already fetched would
  // turn a merely-slow store into a reported failure with zero progress.
  it('returns the pages already fetched when a request times out, instead of throwing', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(100))
      .mockRejectedValueOnce(timeout)
    vi.stubGlobal('fetch', fetchMock)

    const { orders, hasMore } = await fetchOrders(CREDS, {
      modifiedAfter: new Date('2026-07-01T10:00:00Z'),
    })

    expect(orders).toHaveLength(200)
    expect(hasMore).toBe(true)
  })

  // Only a timeout is a stopping condition. A real network failure must still
  // surface as a genuine failure rather than be silently reported as progress.
  it('still throws on a non-timeout failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(100))
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND shop.example'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T10:00:00Z') }),
    ).rejects.toThrow(/ENOTFOUND/)
  })
})

describe('resume points', () => {
  const modifiedPage = (stamps: string[]) =>
    new Response(
      JSON.stringify(stamps.map((date_modified_gmt, i) => ({ id: i, date_modified_gmt }))),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  it('reports the last modified stamp it saw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T10:00:00', '2026-07-01T11:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.resumeFrom).toBe('2026-07-01T11:00:00')
    expect(res.sortedByModified).toBe(true)
  })

  // If the store ignored orderby=modified, advancing to the last row would skip
  // every order it did not happen to return. Say so instead.
  it('refuses to vouch for a store that did not sort by modified date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  it('treats a missing modified stamp as unsortable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const res = await fetchOrders(CREDS, { modifiedAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(false)
  })

  // A first sync is sorted by CREATED date, so modified stamps are legitimately
  // out of order. Checking them there would raise a false alarm every time.
  it('does not judge the ordering of a first-sync chunk', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
      modifiedPage(['2026-07-01T11:00:00', '2026-07-01T10:00:00']),
    ))

    const res = await fetchOrders(CREDS, { createdAfter: new Date('2026-07-01T09:00:00Z') })
    expect(res.sortedByModified).toBe(true)
    expect(res.resumeFrom).toBeUndefined()
  })
})

describe('asking for statuses by name', () => {
  it('names every status when the caller supplies them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOrders(CREDS, { statuses: ['processing', 'completed', 'shipping'] })

    // Sending no status leaves WooCommerce on `any`, which becomes WP's
    // `post_status => 'any'` — and that omits statuses registered with
    // exclude_from_search, exactly how plugins add their own. A store with a
    // "shipping" step then answers with those orders silently absent.
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('status')).toBe('processing,completed,shipping')
  })

  it('falls back to the default rather than narrowing to nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(0))
    vi.stubGlobal('fetch', fetchMock)

    // An empty list means "could not tell what this store uses". Sending
    // `status=` would ask for no statuses at all and return an empty store.
    await fetchOrders(CREDS, { statuses: [] })
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('status')).toBe(false)
  })
})

describe('fetchOrderStatuses', () => {
  it('reports the store own statuses, custom ones included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        statusPage([
          { slug: 'pending', name: 'Pending payment', total: 1 },
          { slug: 'processing', name: 'Processing', total: 4 },
          { slug: 'shipping', name: 'Shipping', total: 3 },
          { slug: 'cancelled', name: 'Cancelled', total: 2 },
        ]),
      ),
    )

    expect(await fetchOrderStatuses(CREDS)).toEqual([
      'pending',
      'processing',
      'shipping',
      'cancelled',
    ])
  })

  it('returns nothing readable as an empty list, never a broken query', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await fetchOrderStatuses(CREDS)).toEqual([])

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchOrderStatuses(CREDS)).toEqual([])
  })
})

describe('fetchCatalog', () => {
  const creds = { url: 'https://shop.test', key: 'k', secret: 's' }

  it('carries price and stock back from one sweep', async () => {
    // Both facts live on the same /products response. Fetching them separately
    // would double the requests for no new information.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 1, price: '649.00', manage_stock: true, stock_quantity: 95 },
      ]), { status: 200 }),
    )
    const catalog = await fetchCatalog(creds)
    expect(catalog.get('1')).toEqual({ price: 64900, stock: 95 })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('reports stock as null when the store does not manage it', async () => {
    // Not zero. Zero means sold out; "not managed" means we do not know, and
    // the difference decides whether a product screams at the top of the page.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 2, price: '10.00', manage_stock: false, stock_quantity: null },
      ]), { status: 200 }),
    )
    expect((await fetchCatalog(creds)).get('2')).toEqual({ price: 1000, stock: null })
    spy.mockRestore()
  })

  it('keeps stock when a product carries no price', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { id: 3, price: '', manage_stock: true, stock_quantity: 7 },
      ]), { status: 200 }),
    )
    expect((await fetchCatalog(creds)).get('3')).toEqual({ price: null, stock: 7 })
    spy.mockRestore()
  })
})

/**
 * A WordPress fatal error answers with a whole HTML page, not JSON. Truncating
 * that to 300 characters keeps only the <head> — doctype, three metas and the
 * opening of <title> — so the error we stored and put on the owner's dashboard
 * was markup, and the one sentence explaining the failure never survived.
 */
describe('a store that answers with an error page', () => {
  const WP_ERROR_PAGE = [
    '<!DOCTYPE html>',
    '<html lang="nb-NO">',
    '<head>',
    '\t<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />',
    '\t<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "\t<meta name='robots' content='max-image-preview:large, noindex, follow' />",
    '\t<title>WordPress &rsaquo; Feil</title>',
    '\t<style type="text/css">html { background: #f1f1f1; }</style>',
    '</head>',
    '<body id="error-page">',
    '\t<div class="wp-die-message"><p>There has been a critical error on this website.</p></div>',
    '</body>',
    '</html>',
  ].join('\n')

  const brokenStore = () =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(WP_ERROR_PAGE, { status: 500 })))

  it('reports what the page says rather than how it is marked up', async () => {
    brokenStore()
    await expect(fetchOrders(CREDS, {})).rejects.toThrow(/critical error on this website/)
  })

  // The status is the half of the message that says which failure this is:
  // 500 is the store breaking, 401 is our key. Extraction must not lose it.
  it('still names the status', async () => {
    brokenStore()
    await expect(fetchOrders(CREDS, {})).rejects.toThrow(/500/)
  })

  it('carries no markup, because this string is shown to the owner', async () => {
    brokenStore()
    const err = await fetchOrders(CREDS, {}).then(
      () => {
        throw new Error('expected a 500 to reject')
      },
      (e: Error) => e,
    )
    expect(err.message).not.toMatch(/[<>]/)
  })
})

/**
 * Panetti Denmark, live on 2026-08-20: "Sync failed / Unexpected end of JSON
 * input". That is V8's message for JSON.parse(''), and it reached the owner's
 * settings page verbatim: no store, no endpoint, nothing to act on.
 *
 * Probed against this Node before fixing anything — ONLY an empty or
 * whitespace-only body produces that exact string. Truncated JSON says
 * "Expected ',' or '}'"; an HTML page says "Unexpected token '<'". So the
 * store answered with a genuinely empty body, and every res.json() in this
 * file sat outside its guard.
 */
describe('a store that answers with nothing', () => {
  const answers = (body: string) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))

  const rejection = async () =>
    fetchOrders(CREDS, {}).then(
      () => {
        throw new Error('expected the empty body to reject')
      },
      (e: Error) => e,
    )

  it('does not hand the owner a JSON parser message', async () => {
    answers('')
    expect((await rejection()).message).not.toMatch(/JSON/i)
  })

  it('says what the store actually did', async () => {
    answers('')
    await expect(fetchOrders(CREDS, {})).rejects.toThrow(/empty response/i)
  })

  /**
   * An empty body is not an empty shop. fetchOrderStatuses falls back to []
   * for exactly this case and is right to — statuses are optional. Doing it
   * here would advance the watermark past orders nobody read and report a
   * healthy sync, which is the one failure worse than a bad error message.
   */
  it('refuses rather than reporting a store with no orders', async () => {
    answers('')
    await expect(fetchOrders(CREDS, {})).rejects.toThrow()
  })

  it('treats a body of only whitespace the same way', async () => {
    answers('  \n\t ')
    await expect(fetchOrders(CREDS, {})).rejects.toThrow(/empty response/i)
  })

  /**
   * The same failure wearing different clothes: a broken store that answers
   * 200 with its error page. "Unexpected token '<'" is no better to read than
   * the parser's other complaint, and the page says why.
   */
  it('reads the page out when a 200 carries HTML instead of orders', async () => {
    answers('<!DOCTYPE html><html><body><p>There has been a critical error.</p></body></html>')
    const err = await rejection()
    expect(err.message).not.toMatch(/Unexpected token/i)
    expect(err.message).toMatch(/critical error/i)
  })

  // The status is meaningful on the error path and this is not it: the store
  // said 200. A bare three-digit number here would be read as an HTTP status
  // by anything downstream that scans for one, the Advisor included.
  it('quotes no status code, because the store reported success', async () => {
    answers('')
    expect((await rejection()).message).not.toMatch(/\b\d{3}\b/)
  })
})
