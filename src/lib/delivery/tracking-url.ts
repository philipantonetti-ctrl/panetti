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
 * Carrier is `Shipment.carrier`: a plain String column with a 'BRING' default,
 * not an enum. So an unknown value means old or bad data rather than a new
 * carrier, and it falls back to Bring - which is exactly where such a row
 * pointed before this existed.
 */
const SITES: Record<string, (escaped: string) => string> = {
  BRING: (n) => `https://tracking.bring.com/tracking/${n}`,
  /**
   * DHL FREIGHT's page, which is the division every parcel we carry belongs
   * to: the client books through mydhlfreight.com on Parcel Connect, and the
   * 10-digit ids on those shipments ARE these tracking numbers.
   *
   * This used to be the generic dhl.com tracking page, on the reasoning that
   * it works out the service itself. It does - by making whoever clicked it
   * wait through a redirect that always lands here. The client asked for this
   * exact URL, and `submit=1` is the load-bearing part of it: without that
   * parameter the page opens its empty search box and the number has to be
   * typed in again.
   */
  DHL: (n) => `https://www.dhl.com/se-en/home/tracking/tracking-freight.html?tracking-id=${n}&submit=1`,
}

export function trackingUrl(trackingNumber: string, carrier: string): string {
  const site = SITES[carrier.toUpperCase()] ?? SITES.BRING
  return site(encodeURIComponent(trackingNumber))
}

/** How each carrier is written for a person to read. */
const NAMES: Record<string, string> = { BRING: 'Bring', DHL: 'DHL' }

/**
 * The carrier's name, as it appears on screen.
 *
 * Note where this DIFFERS from trackingUrl above: an unrecognised carrier
 * falls back to Bring's LINK, because a link has to point somewhere and that
 * is where such a row pointed before. It does NOT fall back to Bring's NAME -
 * labelling a PostNord parcel "Bring" would state something false to whoever
 * is chasing it. An unfamiliar name is a much smaller problem than a wrong one.
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
