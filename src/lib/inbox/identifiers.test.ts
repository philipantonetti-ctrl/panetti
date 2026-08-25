import { describe, expect, it } from 'vitest'
import { orderNumbersIn, trackingNumbersIn, phonesIn, normalizePhone } from './identifiers'

describe('orderNumbersIn', () => {
  it('finds a hash-prefixed number and the number after the word order in five languages', () => {
    expect(orderNumbersIn('Hei, ordre #1042 har ikke kommet')).toEqual(['1042'])
    expect(orderNumbersIn('my order 1042 is late')).toEqual(['1042'])
    expect(orderNumbersIn('Bestilling 1042, ordrenummer 1043')).toEqual(['1042', '1043'])
    expect(orderNumbersIn('Beställning 1042')).toEqual(['1042'])
    expect(orderNumbersIn('Bestellung 1042 / Bestellnummer: 1044')).toEqual(['1042', '1044'])
    expect(orderNumbersIn('Tilaus 1042')).toEqual(['1042'])
  })
  it('keeps a B2B number whole', () => {
    expect(orderNumbersIn('invoice for B-0007 please')).toEqual(['B-0007'])
  })
  it('does not mistake a year, a phone or a tracking number for an order', () => {
    expect(orderNumbersIn('in 2026 I called 91234567')).toEqual([])
    expect(orderNumbersIn('parcel 373123456789012345')).toEqual([])
  })
  it('dedupes', () => {
    expect(orderNumbersIn('#1042 and again order 1042')).toEqual(['1042'])
  })
})

describe('trackingNumbersIn', () => {
  it('finds Bring 18-digit numbers and DHL JJD numbers', () => {
    expect(trackingNumbersIn('Sporing: 373123456789012345.')).toEqual(['373123456789012345'])
    expect(trackingNumbersIn('DHL JJD000390013287654321 stuck')).toEqual(['JJD000390013287654321'])
  })
  it('ignores short digit runs like phones and order numbers', () => {
    expect(trackingNumbersIn('call 91234567 about #1042')).toEqual([])
  })
})

describe('phones', () => {
  it('normalises to digits with the country prefix kept', () => {
    expect(normalizePhone('+47 912 34 567')).toBe('4791234567')
    expect(normalizePhone('0047 912 34 567')).toBe('4791234567')
    expect(normalizePhone('912 34 567')).toBe('91234567')
  })
  it('finds phone-shaped runs in text, normalised', () => {
    expect(phonesIn('ring meg på +47 912 34 567 eller 22 33 44 55')).toEqual(['4791234567', '22334455'])
  })
  it('does not report an order number or a tracking number as a phone', () => {
    expect(phonesIn('order #1042, parcel 373123456789012345')).toEqual([])
  })
})
