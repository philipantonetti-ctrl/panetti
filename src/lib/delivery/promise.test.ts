import { describe, expect, it } from 'vitest'
import { promiseOn, type PromisePoint } from './promise'

const p = (
  shopId: string | null,
  country: string,
  days: number,
  from: string,
  businessDays = true,
): PromisePoint => ({ shopId, country, days, businessDays, effectiveFrom: new Date(from) })

// Two Norwegian shops with different promises is the case this exists for:
// Panetti says 3 days, Mazzetti says 5, and both ship to Norway.
const PANETTI = 'shop-panetti'
const MAZZETTI = 'shop-mazzetti'

const book = [
  p(null, '*', 6, '2026-01-01'), // the catch-all
  p(null, 'NO', 4, '2026-01-01'), // any shop, Norway
  p(PANETTI, 'NO', 3, '2026-01-01'), // Panetti's own Norwegian promise
  p(MAZZETTI, 'NO', 5, '2026-01-01'), // Mazzetti's own
  p(PANETTI, '*', 7, '2026-01-01'), // Panetti everywhere else
]

describe('promiseOn', () => {
  it('gives two shops in the same country their own promises', () => {
    expect(promiseOn(book, PANETTI, 'NO', new Date('2026-08-01'))?.days).toBe(3)
    expect(promiseOn(book, MAZZETTI, 'NO', new Date('2026-08-01'))?.days).toBe(5)
  })

  it('prefers the shop’s own country row over a country row for all shops', () => {
    // A row for "any shop shipping to Norway" exists at 4 days. Panetti's own
    // row must win, or the whole point of per-shop promises is lost.
    expect(promiseOn(book, PANETTI, 'NO', new Date('2026-08-01'))?.days).toBe(3)
  })

  it('falls back to the shop’s own catch-all before any all-shop row', () => {
    // Panetti has no German row, but it does have its own '*'. That is more
    // specific than the all-shops '*', so 7 wins over 6.
    expect(promiseOn(book, PANETTI, 'DE', new Date('2026-08-01'))?.days).toBe(7)
  })

  it('falls back to the all-shops country row when the shop has nothing', () => {
    const other = 'shop-bellino'
    expect(promiseOn(book, other, 'NO', new Date('2026-08-01'))?.days).toBe(4)
  })

  it('falls back to the all-shops catch-all last', () => {
    expect(promiseOn(book, 'shop-bellino', 'DE', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('still resolves when the shop is unknown', () => {
    expect(promiseOn(book, null, 'NO', new Date('2026-08-01'))?.days).toBe(4)
    expect(promiseOn(book, null, 'DE', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('takes the latest row effective on or before the order date', () => {
    const changed = [...book, p(PANETTI, 'NO', 2, '2026-06-01')]
    expect(promiseOn(changed, PANETTI, 'NO', new Date('2026-08-01'))?.days).toBe(2)
  })

  it('does not let a promise changed today rewrite last month', () => {
    const changed = [...book, p(PANETTI, 'NO', 2, '2026-06-01')]
    expect(promiseOn(changed, PANETTI, 'NO', new Date('2026-03-01'))?.days).toBe(3)
  })

  it('picks the most specific row per level, not the newest overall', () => {
    // The all-shops row is NEWER but LESS specific. Specificity wins, or a
    // blanket change would silently override every shop's own promise.
    const mixed = [p(PANETTI, 'NO', 3, '2026-01-01'), p(null, 'NO', 9, '2026-07-01')]
    expect(promiseOn(mixed, PANETTI, 'NO', new Date('2026-08-01'))?.days).toBe(3)
  })

  it('is case-insensitive, so de and DE cannot mean different promises', () => {
    expect(promiseOn(book, PANETTI, 'no', new Date('2026-08-01'))?.days).toBe(3)
  })

  it('treats a missing country as no country, not as a country named ""', () => {
    expect(promiseOn(book, PANETTI, '', new Date('2026-08-01'))?.days).toBe(7)
    expect(promiseOn(book, PANETTI, null, new Date('2026-08-01'))?.days).toBe(7)
  })

  it('returns null when nothing is in force, rather than inventing zero days', () => {
    // Zero days would make every order instantly late. No promise means no
    // judgement: the page says so and the alert stays silent.
    expect(promiseOn(book, PANETTI, 'NO', new Date('2025-01-01'))).toBeNull()
    expect(promiseOn([], PANETTI, 'NO', new Date('2026-08-01'))).toBeNull()
  })
})
