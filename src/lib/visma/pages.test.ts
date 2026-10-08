import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({ vismaGet: vi.fn() }))

import { vismaGet } from './client'
import { vismaGetPages } from './pages'

const CREDS = { clientId: 'c', clientSecret: 's', tenantId: 't' }
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }))

describe('vismaGetPages', () => {
  beforeEach(() => vi.resetAllMocks())

  it('reads page after page until a short one, and says the read is complete', async () => {
    vi.mocked(vismaGet).mockResolvedValueOnce(page(0, 2)).mockResolvedValueOnce(page(2, 1))
    const got = await vismaGetPages(CREDS, 'v1/x?a=1', { pageSize: 2, maxPages: 5 })
    expect(got).toEqual({ rows: page(0, 3), complete: true })
    expect(vi.mocked(vismaGet).mock.calls.map((c) => c[1])).toEqual([
      'v1/x?a=1&pageSize=2&pageNumber=1',
      'v1/x?a=1&pageSize=2&pageNumber=2',
    ])
  })

  it('starts the query string itself when the path has none', async () => {
    vi.mocked(vismaGet).mockResolvedValueOnce([])
    await vismaGetPages(CREDS, 'v1/customer', { pageSize: 1000, maxPages: 3 })
    expect(vi.mocked(vismaGet).mock.calls[0][1]).toBe('v1/customer?pageSize=1000&pageNumber=1')
  })

  /** A full last page is a ceiling, not an end: the caller must not read it as everything. */
  it('says incomplete when it stops at the page limit with a full page', async () => {
    vi.mocked(vismaGet).mockResolvedValueOnce(page(0, 2)).mockResolvedValueOnce(page(2, 2))
    const got = await vismaGetPages(CREDS, 'v1/x', { pageSize: 2, maxPages: 2 })
    expect(got.complete).toBe(false)
    expect(got.rows).toHaveLength(4)
  })

  /**
   * Visma ignores a parameter it does not know and serves page one again
   * (measured on `skip`). If pageNumber were ignored the loop would count the
   * same rows over and over, so a repeated first page stops it, incomplete.
   */
  it('stops, incomplete, when the next page repeats the first one', async () => {
    vi.mocked(vismaGet).mockResolvedValueOnce(page(0, 2)).mockResolvedValueOnce(page(0, 2))
    const got = await vismaGetPages(CREDS, 'v1/x', { pageSize: 2, maxPages: 5 })
    expect(got).toEqual({ rows: page(0, 2), complete: false })
  })
})
