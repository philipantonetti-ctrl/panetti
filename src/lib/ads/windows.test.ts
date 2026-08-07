import { describe, expect, it } from 'vitest'
import { CHUNK_DAYS, chunkRange } from './windows'

const d = (s: string) => new Date(`${s}T00:00:00Z`)
const iso = (x: Date) => x.toISOString().slice(0, 10)

describe('chunkRange', () => {
  it('returns one window when the range already fits', () => {
    expect(chunkRange(d('2026-01-01'), d('2026-02-04'), 90).map((w) => [iso(w.from), iso(w.to)])).toEqual([
      ['2026-01-01', '2026-02-04'],
    ])
  })

  it('splits a year into five 90-day windows', () => {
    const windows = chunkRange(d('2026-01-01'), d('2026-12-31'), 90)
    expect(windows).toHaveLength(5)
    expect(iso(windows[0].from)).toBe('2026-01-01')
    expect(iso(windows[0].to)).toBe('2026-03-31')
    expect(iso(windows[1].from)).toBe('2026-04-01')
    expect(iso(windows[1].to)).toBe('2026-06-29')
    expect(iso(windows[4].to)).toBe('2026-12-31')
  })

  it('leaves no gap and no overlap at a boundary', () => {
    const windows = chunkRange(d('2026-01-01'), d('2026-12-31'), 90)
    for (let i = 1; i < windows.length; i++) {
      const previousEnd = windows[i - 1].to.getTime()
      const nextStart = windows[i].from.getTime()
      expect(nextStart - previousEnd).toBe(24 * 60 * 60 * 1000) // exactly one day on
    }
  })

  it('handles a single-day range', () => {
    expect(chunkRange(d('2026-05-05'), d('2026-05-05'), 90)).toHaveLength(1)
  })

  it('never returns a window when the range runs backwards', () => {
    expect(chunkRange(d('2026-05-05'), d('2026-05-01'), 90)).toEqual([])
  })

  it('uses 90 days as the shared default', () => {
    expect(CHUNK_DAYS).toBe(90)
  })
})
