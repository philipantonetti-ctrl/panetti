import { describe, expect, it } from 'vitest'
import { brandOf, firstNameOf, languageFor, pickupReminderEmail, type ReminderLanguage } from './pickup-reminder-text'

const LANGUAGES: ReminderLanguage[] = ['nb', 'sv', 'da', 'fi', 'de', 'en']

const base = {
  brand: 'Panetti',
  firstName: 'Anna',
  orderNumber: '14689',
  trackingUrl: 'https://tracking.bring.com/tracking/370000000000000000',
  arrivedAt: new Date('2026-09-25T22:30:00Z'),
  timeZone: 'Europe/Oslo',
}

describe('languageFor', () => {
  it('reads the customer’s country', () => {
    expect(languageFor('NO')).toBe('nb')
    expect(languageFor('se')).toBe('sv')
    expect(languageFor('DK')).toBe('da')
    expect(languageFor('FI')).toBe('fi')
    expect(languageFor('DE')).toBe('de')
    expect(languageFor('AT')).toBe('de')
  })

  it('falls back to English when it cannot tell', () => {
    expect(languageFor('')).toBe('en')
    expect(languageFor(null)).toBe('en')
    expect(languageFor('US')).toBe('en')
  })
})

describe('pickupReminderEmail', () => {
  it.each(LANGUAGES)('%s: names the brand, the order and the link, and sells nothing', (language) => {
    const { subject, text } = pickupReminderEmail({ ...base, language })
    expect(subject).toContain('Panetti')
    expect(text).toContain('Anna')
    expect(text).toContain('14689')
    expect(text).toContain(base.trackingUrl)
    expect(text.trim().endsWith('Panetti')).toBe(true)
    // No placeholders left, no long dashes (house style for customer text).
    expect(`${subject}\n${text}`).not.toMatch(/[{}]|undefined|null|—/)
  })

  it('dates the arrival in the shop’s timezone and the customer’s words', () => {
    // 22:30 UTC on the 25th is already the 26th in Oslo.
    expect(pickupReminderEmail({ ...base, language: 'nb' }).text).toContain('siden 26. september')
    expect(pickupReminderEmail({ ...base, language: 'sv' }).text).toContain('sedan 26 september')
    expect(pickupReminderEmail({ ...base, language: 'de' }).text).toContain('seit dem 26. September')
    expect(pickupReminderEmail({ ...base, language: 'fi' }).text).toContain('26. syyskuuta lähtien')
  })

  it('greets without a name when there is none', () => {
    expect(pickupReminderEmail({ ...base, firstName: null, language: 'da' }).text.startsWith('Hej,\n')).toBe(true)
  })
})

describe('firstNameOf / brandOf', () => {
  it('takes the first word, capitalising an all-lower-case name', () => {
    expect(firstNameOf('kari nordmann')).toBe('Kari')
    expect(firstNameOf('  Ole-Petter Hansen ')).toBe('Ole-Petter')
    expect(firstNameOf('McDonald')).toBe('McDonald')
    expect(firstNameOf('')).toBeNull()
    expect(firstNameOf(null)).toBeNull()
    expect(firstNameOf('12345')).toBeNull()
  })

  it('names the brand, not the country shop', () => {
    expect(brandOf('Panetti Norway')).toBe('Panetti')
    expect(brandOf('Mazzetti')).toBe('Mazzetti')
  })
})
