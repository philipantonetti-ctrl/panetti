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
  // The generic tracking page, deliberately, not one of the product-specific
  // ones. Our DHL parcels come back as a mix of services - 'freight' and
  // 'ecommerce' both seen on the live API - and this page works out which is
  // which itself, where tracking-parcel.html would be wrong for half of them.
  DHL: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`,
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
