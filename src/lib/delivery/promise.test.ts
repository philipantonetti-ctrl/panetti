import { describe, expect, it } from 'vitest'
import { promiseOn, type PromisePoint } from './promise'

const p = (country: string, days: number, from: string, businessDays = true): PromisePoint => ({
  country, days, businessDays, effectiveFrom: new Date(from),
})

const book = [
  p('*', 6, '2026-01-01'),
  p('NO', 3, '2026-01-01'),
  p('NO', 2, '2026-06-01'),
  p('SE', 4, '2026-01-01'),
]

describe('promiseOn', () => {
  it('takes the latest row effective on or before the order date', () => {
    expect(promiseOn(book, 'NO', new Date('2026-08-01'))?.days).toBe(2)
  })

  it('does not let a promise changed today rewrite last month', () => {
    expect(promiseOn(book, 'NO', new Date('2026-03-01'))?.days).toBe(3)
  })

  it('falls back to the star row for a country with none of its own', () => {
    expect(promiseOn(book, 'DE', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('falls back to the star row when the country is unknown', () => {
    expect(promiseOn(book, null, new Date('2026-08-01'))?.days).toBe(6)
    expect(promiseOn(book, '', new Date('2026-08-01'))?.days).toBe(6)
  })

  it('is case-insensitive, so de and DE cannot mean different promises', () => {
    expect(promiseOn(book, 'no', new Date('2026-08-01'))?.days).toBe(2)
  })

  it('returns null when nothing is in force, rather than inventing zero days', () => {
    // Zero days would make every order instantly late. No promise means no
    // judgement — the page says so and the alert stays silent.
    expect(promiseOn(book, 'NO', new Date('2025-01-01'))).toBeNull()
    expect(promiseOn([], 'NO', new Date('2026-08-01'))).toBeNull()
  })
})
