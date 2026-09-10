import { describe, expect, it } from 'vitest'
import { trackingNoteText } from './woo-notes'

/**
 * What a person actually reads in the order's note panel. Two lines: who is
 * carrying it and under which number, then the link. The number is repeated
 * outside the URL on purpose - it is the value support quotes on the phone and
 * pastes into the carrier's own site, and a bare link hides it.
 */
describe('trackingNoteText', () => {
  it('names the carrier and the number, then links to the carrier', () => {
    expect(trackingNoteText('BRING', '73325383679943459')).toBe(
      'Bring 73325383679943459\nhttps://tracking.bring.com/tracking/73325383679943459',
    )
  })

  it('sends a DHL parcel to the DHL Freight page', () => {
    expect(trackingNoteText('DHL', '6106283101')).toBe(
      'DHL 6106283101\nhttps://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=6106283101&submit=1',
    )
  })

  /**
   * UNKNOWN has no page to link to - a person can link a parcel to an order by
   * hand before the poller has identified its carrier. Without a guard here
   * the second line was the literal text "null", posted to a live order.
   */
  it('drops the link line for a carrier with no page, rather than printing null', () => {
    expect(trackingNoteText('UNKNOWN', '473325380028549070')).toBe('Unknown 473325380028549070')
  })
})
