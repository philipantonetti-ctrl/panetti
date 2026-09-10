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
   * Shipment.carrier is a plain String column, not an enum, so an
   * unrecognised value is a data problem rather than a new carrier. This used
   * to fall back to Bring's page - exactly the wrong site for a PostNord or a
   * blank-carrier row, and one that finds nothing for either. No link is the
   * honest state now.
   */
  it('gives a carrier it does not know no link, rather than defaulting to Bring', () => {
    expect(trackingUrl('123', 'POSTNORD')).toBeNull()
    expect(trackingUrl('123', '')).toBeNull()
  })

  it('escapes the number so it cannot break out of the query string', () => {
    expect(trackingUrl('a&b=c', 'DHL')).toContain('a%26b%3Dc')
    expect(trackingUrl('a/b', 'BRING')).toContain('a%2Fb')
  })

  it('gives an UNKNOWN carrier no link at all, rather than a Bring page that finds nothing', () => {
    expect(trackingUrl('473325380028549070', 'UNKNOWN')).toBeNull()
    expect(carrierName('UNKNOWN')).toBe('Unknown')
  })

  it('sends an 18-digit DHL number to DHL\'s unified page and a 10-digit one to the freight page', () => {
    expect(trackingUrl('473325380023179098', 'DHL')).toBe(
      'https://www.dhl.com/se-en/home/tracking.html?tracking-id=473325380023179098',
    )
    expect(trackingUrl('9599036010', 'DHL')).toBe(
      'https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=9599036010&submit=1',
    )
  })
})
