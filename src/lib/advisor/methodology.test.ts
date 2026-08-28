import { describe, expect, it } from 'vitest'
import { METHODOLOGY } from './methodology'

describe('METHODOLOGY', () => {
  it('states the profit formula the engine actually uses', () => {
    expect(METHODOLOGY).toMatch(/net sales/i)
    expect(METHODOLOGY).toMatch(/COGS/)
    expect(METHODOLOGY).toMatch(/VAT/)
  })

  /**
   * "Business days" invites the reader to assume public holidays are excluded.
   * They are not modelled at all (src/lib/delivery/days.ts), and asked how
   * lateness works the assistant said "weekends and holidays don't push an
   * order into late" - a confident sentence about a rule that does not exist.
   * The gap in the text was the cause, so the text closes it.
   */
  it('does not let business days imply that holidays are excluded', () => {
    expect(METHODOLOGY).toMatch(/PUBLIC HOLIDAYS ARE NOT MODELLED/)
    expect(METHODOLOGY).toMatch(/do not describe holidays as excluded/)
  })

  it('explains how the forecast reaches an order quantity', () => {
    expect(METHODOLOGY).toMatch(/day by day/i)
    expect(METHODOLOGY).toMatch(/container/i)
  })

  /**
   * The whole point of shipping method text is that the model stops inventing
   * it. A MEASURED figure in here would be a number nobody computed, cached
   * into every request and stated with total confidence - the one thing this
   * product must never ship.
   *
   * The three below are rules of the system rather than measurements: the
   * default commission rate, the window the sales rate is measured over, and
   * the default cover days. Pinned as a list so a fourth number cannot arrive
   * unnoticed. Digits inside words (the 2 of B2B) are not figures.
   */
  it('carries no figures of its own beyond the fixed rules of the system', () => {
    const numbers = METHODOLOGY.match(/(?<![A-Za-z])\d+(?:[.,]\d+)?(?![A-Za-z])/g) ?? []
    expect(numbers).toEqual(['10', '60', '90'])
  })
})
