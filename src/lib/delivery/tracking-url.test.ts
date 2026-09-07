import { describe, expect, it } from 'vitest'
import { carrierName, trackingUrl } from './tracking-url'

describe('carrierName', () => {
  it('writes each carrier the way a person would', () => {
    expect(carrierName('BRING')).toBe('Bring')
    // An initialism stays upper case; 'Dhl' would look like a typo.
    expect(carrierName('DHL')).toBe('DHL')
  })

  /**
   * The column default is 'BRING', so a blank is a row written before the
   * column existed rather than a carrier nobody named. It reads as Bring for
   * the same reason its link points at Bring.
   */
  it('reads a blank as Bring, matching the column default and the link', () => {
    expect(carrierName('')).toBe('Bring')
  })

  /**
   * Never silently relabel an unknown carrier as Bring. The link has to fall
   * back somewhere, but a NAME that lies is worse than an unfamiliar one - it
   * would tell an operator a PostNord parcel is Bring's.
   */
  it('shows an unrecognised carrier under its own name, never as Bring', () => {
    expect(carrierName('POSTNORD')).toBe('Postnord')
  })
})

describe('trackingUrl', () => {
  it('sends a DHL parcel to DHL, not to Bring', () => {
    const url = trackingUrl('9599861672', 'DHL')
    expect(url).toContain('dhl.com')
    expect(url).not.toContain('bring.com')
    expect(url).toContain('9599861672')
  })

  /**
   * The FREIGHT page, exactly as the client sent it, `submit=1` included -
   * without that parameter the page loads its empty search form and the
   * number has to be entered again by hand.
   *
   * Every DHL parcel we carry is DHL Freight Parcel Connect (the portal is
   * mydhlfreight.com and the 10-digit ids are these tracking numbers), so the
   * generic dhl.com page this used to return was one redirect further from
   * the answer for all of them.
   */
  it('sends a DHL parcel to the Freight tracking page the client uses', () => {
    expect(trackingUrl('6106283101', 'DHL')).toBe(
      'https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=6106283101&submit=1',
    )
  })

  it('sends a Bring parcel to Bring', () => {
    expect(trackingUrl('TESTPACKAGE-AT-PICKUPPOINT', 'BRING')).toBe(
      'https://tracking.bring.com/tracking/TESTPACKAGE-AT-PICKUPPOINT',
    )
  })

  /**
   * Shipment.carrier is a plain String column defaulting to 'BRING', not an
   * enum, so an unrecognised value is a data problem rather than a new
   * carrier. Falling back to Bring keeps every row that predates the column
   * pointing exactly where it pointed before.
   */
  it('falls back to Bring for a carrier it does not know, matching the column default', () => {
    expect(trackingUrl('123', 'POSTNORD')).toContain('bring.com')
    expect(trackingUrl('123', '')).toContain('bring.com')
  })

  it('escapes the number so it cannot break out of the query string', () => {
    expect(trackingUrl('a&b=c', 'DHL')).toContain('a%26b%3Dc')
    expect(trackingUrl('a/b', 'BRING')).toContain('a%2Fb')
  })
})
