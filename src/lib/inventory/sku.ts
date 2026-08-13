/**
 * One product is one SKU, trimmed and uppercased.
 *
 * `Product` is shop-scoped, so the same physical item is up to nine rows. Every
 * purchasing fact — who makes it, how long it takes, how many fit a container —
 * belongs to the object rather than to a German listing, so SKU is the key.
 * `AmbassadorProduct` already keys on SKU for the same reason.
 */
export function normaliseSku(raw: string): string {
  return raw.trim().toUpperCase()
}

/**
 * False for a SKU that cannot identify a product.
 *
 * Blank is obvious. All-zeros is not: six live products carry the SKU "0", and
 * they are not one product — the set spans Panetti Pizzetta Primo AND Mazzetti
 * Advanced Comfort. Treating that as a key would pool a pizza oven's sales with
 * a massage chair's and order containers of the average. Such products are
 * excluded from the forecast and named on the page, never silently merged.
 */
export function isUsableSku(raw: string): boolean {
  const sku = normaliseSku(raw)
  if (sku.length === 0) return false
  return !/^0+$/.test(sku)
}
