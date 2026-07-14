import { describe, it, expect } from 'vitest'
import { ordinal, recurrenceDetail, finalPayment, formatDay } from './expense-format'

describe('ordinal', () => {
  it('handles the ordinary cases', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(4)).toBe('4th')
    expect(ordinal(14)).toBe('14th')
    expect(ordinal(21)).toBe('21st')
    expect(ordinal(22)).toBe('22nd')
    expect(ordinal(23)).toBe('23rd')
    expect(ordinal(31)).toBe('31st')
  })

  it('handles the teens, which are the ones everyone gets wrong', () => {
    expect(ordinal(11)).toBe('11th') // not 11st
    expect(ordinal(12)).toBe('12th') // not 12nd
    expect(ordinal(13)).toBe('13th') // not 13rd
  })
})

describe('recurrenceDetail', () => {
  it('says which day of the month a monthly expense is paid, and that it is spread', () => {
    expect(recurrenceDetail('MONTHLY', new Date('2026-07-01'))).toBe('on the 1st, spread daily')
    expect(recurrenceDetail('MONTHLY', new Date('2026-07-22'))).toBe('on the 22nd, spread daily')
  })

  it('says the date a yearly expense is paid', () => {
    expect(recurrenceDetail('YEARLY', new Date('2026-01-01'))).toBe('on 1 Jan, spread daily')
  })

  it('describes weekly and daily', () => {
    expect(recurrenceDetail('WEEKLY', new Date('2026-07-01'))).toBe('spread daily')
    expect(recurrenceDetail('DAILY', new Date('2026-07-01'))).toBe('every day')
  })

  it('gives the exact date for a one-off', () => {
    expect(recurrenceDetail('ONE_TIME', new Date('2026-07-05'))).toBe('one-off on 5 Jul 2026')
  })
})

describe('finalPayment', () => {
  it('is N/A while an expense is still running', () => {
    expect(finalPayment(null)).toBe('N/A')
  })

  it('is the end date once one is set', () => {
    expect(finalPayment(new Date('2026-03-31'))).toBe('31 Mar 2026')
  })
})

describe('formatDay', () => {
  it('formats a date the same way everywhere, whatever the machine locale', () => {
    expect(formatDay(new Date('2026-07-14'))).toBe('14 Jul 2026')
  })
})
