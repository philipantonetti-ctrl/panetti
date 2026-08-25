import { describe, expect, it } from 'vitest'
import { describeSources } from './describe'

describe('describeSources', () => {
  /**
   * Counts, not names. The one fact a reader needs from a page header is that
   * the two columns are counted from DIFFERENT numbers of shops; which two
   * shops is a settings question, and nine shop names is not a subtitle anyone
   * reads.
   */
  it('gives the two counts when the stock is scoped', () => {
    expect(describeSources(['Panetti Norway', 'Mazzetti Norway'], 9)).toBe(
      'Stock from 2 shops. Sales from all 9.',
    )
  })

  it('reads naturally for a single source', () => {
    expect(describeSources(['Panetti Norway'], 9)).toBe('Stock from 1 shop. Sales from all 9.')
  })

  it('never names a shop, however few there are', () => {
    expect(describeSources(['Panetti Norway'], 9)).not.toMatch(/Panetti/)
    expect(describeSources(['A', 'B'], 4)).not.toMatch(/\b[AB]\b/)
  })

  /**
   * The state every workspace is in until someone ticks a box. It must not read
   * as a misconfiguration - nothing is wrong, every shop simply counts.
   */
  it('says so plainly when no shop has been singled out', () => {
    expect(describeSources([], 9)).toBe('Stock and sales from all 9 shops.')
  })

  it('does not say "all" or pluralise when there is one shop', () => {
    expect(describeSources([], 1)).toBe('Stock and sales from 1 shop.')
  })

  /**
   * Ticking every shop is the same set as ticking none, so it must not claim a
   * split that does not exist.
   */
  it('collapses to the plain sentence when every shop is a source', () => {
    expect(describeSources(['A', 'B', 'C'], 3)).toBe('Stock and sales from all 3 shops.')
  })

  it('survives a workspace with no shops at all', () => {
    expect(describeSources([], 0)).toBe('No shops connected yet.')
  })
})
