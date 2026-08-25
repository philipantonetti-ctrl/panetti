import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchTracking, requestBudgetMs } from './client'

const creds = { uid: 'ops@example.com', key: 'secret-key', clientUrl: 'https://panetti.vercel.app' }

afterEach(() => vi.unstubAllGlobals())

/**
 * A `fetch` stub whose CALLS are typed, so the tests can read the url and the
 * headers back.
 *
 * The signature is supplied as a type argument rather than as parameters the
 * body ignores. `vi.fn(async () => ...)` alone infers a ZERO-ARG mock, which
 * makes `fn.mock.calls[0][0]` a type error - indexing an empty tuple - even
 * though it works at runtime. That matters here: tsconfig includes `**\/*.ts`,
 * so test files are typechecked and `next build` fails on this, while every
 * test still passes.
 */
function stub(status: number, body: unknown) {
  const fn = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('fetchTracking', () => {
  it('sends the three Mybring headers', async () => {
    const fn = stub(200, { consignmentSet: [] })
    await fetchTracking(creds, ['123'])
    const headers = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-Mybring-API-Uid']).toBe('ops@example.com')
    expect(headers['X-Mybring-API-Key']).toBe('secret-key')
    expect(headers['X-Bring-Client-URL']).toBe('https://panetti.vercel.app')
  })

  it('asks for every number in one request', async () => {
    const fn = stub(200, { consignmentSet: [] })
    await fetchTracking(creds, ['A', 'B'])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(String(fn.mock.calls[0][0])).toContain('q=A&q=B')
  })

  it('issues no request at all for an empty list', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    expect(await fetchTracking(creds, [])).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns the consignments Bring sent back', async () => {
    stub(200, { consignmentSet: [{ consignmentId: 'A' }, { consignmentId: 'B' }] })
    expect(await fetchTracking(creds, ['A', 'B'])).toHaveLength(2)
  })

  it('treats no consignmentSet as nothing found, not as a crash', async () => {
    stub(200, {})
    expect(await fetchTracking(creds, ['A'])).toEqual([])
  })

  it('truncates a huge error body, so no HTML page reaches a log or a toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000), { status: 500 })))
    await expect(fetchTracking(creds, ['A'])).rejects.toThrow(/Bring responded 500/)
    await expect(fetchTracking(creds, ['A'])).rejects.toSatisfy(
      (e: Error) => e.message.length < 400,
    )
  })

  it('never asks for longer than the deadline leaves', () => {
    const now = 1_000_000
    expect(requestBudgetMs({ deadline: now + 5_000 }, now)).toBe(5_000)
    expect(requestBudgetMs({ deadline: now + 90_000 }, now)).toBe(30_000)
    // No deadline at all: the caller gets the full ceiling. Task 8 calls this
    // way whenever it runs outside the cron's budget, so this is the ordinary
    // path, not an edge case.
    expect(requestBudgetMs({}, now)).toBe(30_000)
    // An expired budget is still a valid timeout; the caller's loop is what stops.
    expect(requestBudgetMs({ deadline: now - 1 }, now)).toBe(1)
  })
})
