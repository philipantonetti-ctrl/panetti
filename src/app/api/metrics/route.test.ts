import { describe, it, expect } from 'vitest'
import { rangeFromQuery, shopIdsFromQuery } from '@/lib/api/range'

const now = new Date('2026-07-14T12:00:00Z')
const q = (s: string) => new URLSearchParams(s)

describe('rangeFromQuery', () => {
  it('reads an explicit from/to', () => {
    const r = rangeFromQuery(q('from=2026-07-01&to=2026-07-10'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-07-10')
  })

  it('reads a preset', () => {
    const r = rangeFromQuery(q('preset=today'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-14')
  })

  it('swaps a backwards range instead of returning nothing', () => {
    const r = rangeFromQuery(q('from=2026-07-10&to=2026-07-01'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-07-10')
  })

  it('falls back to this month when the query is nonsense', () => {
    const r = rangeFromQuery(q('preset=banana'), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
  })

  it('falls back to this month when there is no query at all', () => {
    const r = rangeFromQuery(q(''), now)
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-07-01')
  })
})

describe('shopIdsFromQuery', () => {
  it('splits a comma-separated list', () => {
    expect(shopIdsFromQuery(q('shops=a,b,c'))).toEqual(['a', 'b', 'c'])
  })

  it('returns undefined (= all shops) when absent or empty', () => {
    expect(shopIdsFromQuery(q(''))).toBeUndefined()
    expect(shopIdsFromQuery(q('shops='))).toBeUndefined()
  })
})
