import { describe, expect, it } from 'vitest'
import ecommerce from './__fixtures__/dhl-ecommerce.json'
import freight from './__fixtures__/dhl-freight.json'
import bring from './__fixtures__/bring-consignment.json'
import { bringFacts, dhlFacts, unknownNext, UNKNOWN_GRACE_DAYS } from './identify'

const DAY = 24 * 60 * 60 * 1000

describe('dhlFacts', () => {
  it('reads a DHL eCommerce parcel: country, weight, no references, events mapped', () => {
    const f = dhlFacts(ecommerce, '473325380023179098')!
    expect(f.carrier).toBe('DHL')
    expect(f.consignmentId).toBe('00473325380023179098')
    expect(f.destinationCountry).toBe('DE')
    expect(f.weightKg).toBe(18.2)
    expect(f.references).toEqual([])
    expect(f.recipientEmail).toBeNull()
    expect(f.package?.events).toHaveLength(3)
    expect(f.package?.milestones.handedInAt).not.toBeNull()
  })

  it('reads a DHL Freight shipment: the 10-digit consignment numbers are its references', () => {
    const f = dhlFacts(freight, '473325380028549070')!
    expect(f.destinationCountry).toBe('FI')
    expect(f.weightKg).toBe(154)
    expect(f.consignmentId).toBe('JKG-HI-0001643')
    expect(f.references).toEqual(['6109278751', '00063491697'])
    expect(f.package?.trackingNumber).toBe('473325380028549070')
  })

  it('is null when DHL returned no shipment', () => {
    expect(dhlFacts({ shipments: [] }, '1')).toBeNull()
    expect(dhlFacts(null, '1')).toBeNull()
  })
})

describe('bringFacts', () => {
  it('reads the consignment and the events of the package asked about', () => {
    const f = bringFacts(bring, '473325380023135087')!
    expect(f.carrier).toBe('BRING')
    expect(f.consignmentId).toBe('73325383681096808')
    expect(f.recipientEmail).toBe('buyer@example.test')
    expect(f.recipientName).toBe('Test Person')
    expect(f.destinationCountry).toBe('DK')
    expect(f.weightKg).toBe(16)
    expect(f.references).toEqual([])
    expect(f.package?.trackingNumber).toBe('473325380023135087')
    expect(f.package?.milestones.bookedAt).toEqual(new Date('2026-09-07T08:17:14.000Z'))
  })

  it('is null for an error entry or an empty answer', () => {
    expect(bringFacts([{ error: { code: 404, message: 'No shipments found' } }], '1')).toBeNull()
    expect(bringFacts([], '1')).toBeNull()
  })
})

describe('unknownNext', () => {
  const now = new Date('2026-09-10T12:00:00Z')

  it('asks again tomorrow while the number is young', () => {
    const r = unknownNext(new Date(now.getTime() - 2 * DAY), now)
    expect(r.terminal).toBe(false)
    expect(r.nextPollAt).toEqual(new Date(now.getTime() + DAY))
    expect(r.lastError).toBe('Neither Bring nor DHL knows this number')
    expect(r.unlinkedReason).toBeNull()
  })

  it('gives up after the grace period and says so in the reason', () => {
    const r = unknownNext(new Date(now.getTime() - (UNKNOWN_GRACE_DAYS + 1) * DAY), now)
    expect(r.terminal).toBe(true)
    expect(r.nextPollAt).toBeNull()
    expect(r.unlinkedReason).toBe('No carrier knew this number in 14 days')
  })
})
