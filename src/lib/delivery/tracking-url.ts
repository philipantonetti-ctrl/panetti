/**
 * Where a human goes to look at one parcel.
 *
 * One function, in one place, because this link is built in three: the late
 * table on the delivery page, the unlinked-parcels table beside it, and the
 * Slack alert. All three used to hardcode Bring's tracking site, so from the
 * day DHL parcels started arriving, every DHL link led somewhere that has
 * never heard of the number — including the Slack alert, which is the one the
 * client actually clicks.
 *
 * Carrier is `Shipment.carrier`: a plain String column with a 'BRING' default,
 * not an enum. So an unknown value means old or bad data rather than a new
 * carrier, and it falls back to Bring — which is exactly where such a row
 * pointed before this existed.
 */
const SITES: Record<string, (escaped: string) => string> = {
  BRING: (n) => `https://tracking.bring.com/tracking/${n}`,
  // The generic tracking page, deliberately, not one of the product-specific
  // ones. Our DHL parcels come back as a mix of services — 'freight' and
  // 'ecommerce' both seen on the live API — and this page works out which is
  // which itself, where tracking-parcel.html would be wrong for half of them.
  DHL: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`,
}

export function trackingUrl(trackingNumber: string, carrier: string): string {
  const site = SITES[carrier.toUpperCase()] ?? SITES.BRING
  return site(encodeURIComponent(trackingNumber))
}
