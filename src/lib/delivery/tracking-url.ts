/**
 * Where a human goes to look at one parcel.
 *
 * One function, in one place, because this link is built in three: the late
 * table on the delivery page, the unlinked-parcels table beside it, and the
 * Slack alert. All three used to hardcode Bring's tracking site, so from the
 * day DHL parcels started arriving, every DHL link led somewhere that has
 * never heard of the number - including the Slack alert, which is the one the
 * client actually clicks.
 *
 * Carrier is `Shipment.carrier`: a plain String column, not an enum, so
 * 'UNKNOWN' is a real value rather than a typo - it is what a parcel gets
 * while no carrier has claimed it yet. See trackingUrl below for what a
 * carrier this file has no page for gets: not a Bring link any more.
 */
const SITES: Record<string, (escaped: string, raw: string) => string> = {
  BRING: (n) => `https://tracking.bring.com/tracking/${n}`,
  /**
   * Two DHL pages. The freight page knows the 10-digit consignment numbers
   * the DHL export carries. An 18-digit number is a piece id, which the
   * unified page resolves for both DHL Freight and DHL eCommerce parcels
   * (both divisions carry the warehouse's parcels; measured 2026-09-10).
   */
  DHL: (n, raw) =>
    /^\d{18}$/.test(raw)
      ? `https://www.dhl.com/se-en/home/tracking.html?tracking-id=${n}`
      : `https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=${n}&submit=1`,
}

/**
 * Null for a carrier we have no page for - including UNKNOWN, a parcel no
 * carrier has claimed yet. A link that opens the wrong carrier's page and
 * finds nothing is what the Delivery page showed for 41 parcels; no link is
 * the honest state.
 */
export function trackingUrl(trackingNumber: string, carrier: string): string | null {
  const site = SITES[carrier.toUpperCase()]
  if (!site) return null
  return site(encodeURIComponent(trackingNumber), trackingNumber)
}

/** How each carrier is written for a person to read. */
const NAMES: Record<string, string> = { BRING: 'Bring', DHL: 'DHL' }

/**
 * The carrier's name, as it appears on screen.
 *
 * Note where this DIFFERS from trackingUrl above: an unrecognised carrier's
 * NAME falls back to a capitalised form of its own code ('POSTNORD' becomes
 * 'Postnord'), never to Bring's - labelling a PostNord parcel "Bring" would
 * state something false to whoever is chasing it, and an unfamiliar name is
 * a much smaller problem than a wrong one. trackingUrl's LINK has no such
 * fallback: a carrier this file has no page for gets no link at all.
 *
 * A blank is the exception, and not really one: the column defaults to 'BRING',
 * so an empty value is a row written before the column existed rather than an
 * unnamed carrier.
 */
export function carrierName(carrier: string): string {
  const key = carrier.trim().toUpperCase()
  if (!key) return NAMES.BRING
  return NAMES[key] ?? key.charAt(0) + key.slice(1).toLowerCase()
}
