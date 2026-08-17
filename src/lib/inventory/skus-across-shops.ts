/**
 * Is one product one SKU across the webshops, or does each country invent its own?
 *
 * Nothing on any page answers this, and everything in the purchasing side rests
 * on it: sales are pooled by SKU, so if Sweden lists PZO-500-SE against Norway's
 * PZO-500 then Swedish demand never reaches the Norwegian row, and a forecast
 * scoped to the Norwegian shops orders for one country while five sell.
 *
 * Pure on purpose. The route hands it rows and gets a report back, so the shape
 * of the answer can be tested without a database.
 */

import { VOIDED_STATUSES } from '../metrics/types'
import { isUsableSku, normaliseSku } from './sku'

/**
 * The countries the shops sell into, as the two-letter codes a SKU would carry.
 *
 * Only these five, and only as a whole token at one end. A wider rule finds
 * more "families", and every extra one is a guess presented as a finding.
 */
const COUNTRY_CODES = ['NO', 'SE', 'DK', 'FI', 'DE'] as const

/** Below this, a stripped stem is too short to be evidence of anything. */
const MIN_STEM = 3

/**
 * What two SKUs would share if they were one product coded twice.
 *
 * Punctuation and case go first, then a single country code off either end:
 * PZO-500, pzo500, PZO-500-SE and SE-PZO-500 all reduce to PZO500. Both ends,
 * because nobody has told us which convention these shops use — that is what
 * the report is for — and looking at one end only would return a clean answer
 * for a workspace where every product had five codes.
 */
export function skuStem(sku: string): string {
  const bare = normaliseSku(sku).replace(/[^A-Z0-9]/g, '')
  for (const code of COUNTRY_CODES) {
    if (bare.length - code.length < MIN_STEM) continue
    if (bare.endsWith(code)) return bare.slice(0, -code.length)
    if (bare.startsWith(code)) return bare.slice(code.length)
  }
  return bare
}

export type Listing = {
  shopName: string
  sku: string
  name: string
  /** Marked as a stock source, so the Forecast tab lists what it carries. */
  isSource: boolean
  isActive: boolean
}

export type ShopSkus = {
  shopName: string
  isSource: boolean
  isActive: boolean
  /** Distinct usable SKUs this shop lists. */
  skus: number
  /** Of those, how many no other shop carries. */
  onlyHere: number
}

/** A SKU that is selling while the forecast cannot see it. */
export type BlindSpot = {
  sku: string
  /** The shops that do carry it, alphabetically. */
  shops: string[]
  recentUnits: number
}

/** One SKU inside a family of codes that look like the same product. */
export type Variant = BlindSpot & {
  /** True when a source shop carries this one, so the forecast keeps it. */
  sourced: boolean
}

export type Cluster = {
  stem: string
  /** Two or more, biggest seller first. A family of one is not a family. */
  variants: Variant[]
}

export type SkuReport = {
  /** SKUs more than one shop carries. High = one product, one SKU everywhere. */
  sharedSkus: number
  /** SKUs exactly one shop carries. High = each country has its own codes. */
  soleShopSkus: number
  /** Alphabetical, so two loads of the same data read the same way. */
  shops: ShopSkus[]
  /**
   * Selling SKUs that no source shop carries, biggest first. Empty when nobody
   * has named a source, because then the forecast lists everything.
   */
  sellingButNotSourced: BlindSpot[]
  /**
   * Families of codes that look like one product listed under several. Empty is
   * the good answer: it means one product really is one SKU everywhere.
   */
  clusters: Cluster[]
}

export function skusAcrossShops(
  listings: Listing[],
  /** Units sold recently, per normalised SKU. */
  recentUnits: Map<string, number>,
): SkuReport {
  const shopsBySku = new Map<string, Set<string>>()
  /** One row per shop, whether or not any of its SKUs turn out to be usable. */
  const perShop = new Map<string, { isSource: boolean; isActive: boolean; skus: Set<string> }>()
  /** SKUs at least one source shop carries — what the forecast can see. */
  const sourced = new Set<string>()

  // The sales side gets the same normalisation as the listings. A key that
  // misses its SKU reads as no units, no units reads as no blind spot, and the
  // report then reassures on the strength of a failed lookup.
  const units = new Map<string, number>()
  for (const [raw, n] of recentUnits) {
    if (!isUsableSku(raw)) continue
    const sku = normaliseSku(raw)
    // Added, not replaced: two keys for one product are two halves of its
    // demand, and keeping the last would shrink the blind spot by whichever
    // half iterated second.
    units.set(sku, (units.get(sku) ?? 0) + n)
  }

  for (const l of listings) {
    const shop =
      perShop.get(l.shopName) ??
      { isSource: l.isSource, isActive: l.isActive, skus: new Set<string>() }
    perShop.set(l.shopName, shop)

    // The same rules the forecast uses, so the two agree about what a SKU is.
    if (!isUsableSku(l.sku)) continue
    const sku = normaliseSku(l.sku)
    shop.skus.add(sku)
    if (l.isSource) sourced.add(sku)

    const shops = shopsBySku.get(sku) ?? new Set<string>()
    shops.add(l.shopName)
    shopsBySku.set(sku, shops)
  }

  let sharedSkus = 0
  let soleShopSkus = 0
  for (const shops of shopsBySku.values()) {
    if (shops.size > 1) sharedSkus++
    else soleShopSkus++
  }

  const shops = [...perShop]
    .map(([shopName, shop]) => ({
      shopName,
      isSource: shop.isSource,
      isActive: shop.isActive,
      skus: shop.skus.size,
      onlyHere: [...shop.skus].filter((sku) => shopsBySku.get(sku)!.size === 1).length,
    }))
    .sort((a, b) => a.shopName.localeCompare(b.shopName))

  const blindSpot = (sku: string): BlindSpot => ({
    sku,
    shops: [...shopsBySku.get(sku)!].sort((a, b) => a.localeCompare(b)),
    recentUnits: units.get(sku) ?? 0,
  })

  // Biggest seller first, SKU as the tiebreaker so a tie cannot reshuffle
  // between two loads of the same data.
  const bySales = (a: BlindSpot, b: BlindSpot) =>
    b.recentUnits - a.recentUnits || a.sku.localeCompare(b.sku)

  // Nobody has named a source, so the forecast lists every SKU and there is no
  // blind spot to report. Reading `sourced` alone would say the opposite —
  // every SKU unsourced — which is the most alarming possible way to describe a
  // workspace where nothing is wrong.
  const scoped = sourced.size > 0
  const sellingButNotSourced: BlindSpot[] = !scoped
    ? []
    : [...shopsBySku.keys()]
        .filter((sku) => !sourced.has(sku) && (units.get(sku) ?? 0) > 0)
        .map(blindSpot)
        .sort(bySales)

  const byStem = new Map<string, string[]>()
  for (const sku of shopsBySku.keys()) {
    const stem = skuStem(sku)
    byStem.set(stem, [...(byStem.get(stem) ?? []), sku])
  }

  const total = (c: Cluster) => c.variants.reduce((n, v) => n + v.recentUnits, 0)
  const clusters: Cluster[] = [...byStem]
    .filter(([, skus]) => skus.length > 1)
    .map(([stem, skus]) => ({
      stem,
      variants: skus
        .map((sku) => ({ ...blindSpot(sku), sourced: sourced.has(sku) }))
        .sort(bySales),
    }))
    .sort((a, b) => total(b) - total(a) || a.stem.localeCompare(b.stem))

  return { sharedSkus, soleShopSkus, shops, sellingButNotSourced, clusters }
}

/** An order line, as the route's query loads it. */
export type SoldLine = {
  sku: string
  quantity: number
  order: { status: string }
}

/**
 * Units sold per SKU, ready to hand to `skusAcrossShops`.
 *
 * The voided check is repeated here in JavaScript, exactly as `loadInventory`
 * and the Woo sync both repeat it: a SQL `notIn` is case-sensitive and Woo
 * stores each status exactly as the store sent it, custom plugin statuses
 * included. A cancelled order counted here would invent demand and turn a
 * dead SKU into an urgent blind spot.
 */
export function unitsBySku(lines: SoldLine[]): Map<string, number> {
  const units = new Map<string, number>()
  for (const l of lines) {
    if (VOIDED_STATUSES.includes(l.order.status.toLowerCase() as never)) continue
    if (!isUsableSku(l.sku)) continue
    const sku = normaliseSku(l.sku)
    units.set(sku, (units.get(sku) ?? 0) + l.quantity)
  }
  return units
}

/** A product row, as the route's query loads it. */
export type ListedProduct = {
  sku: string
  name: string
  shop: { name: string; stockSource: boolean; active: boolean }
}

/**
 * Flatten each shop's listing rows into what the report reads.
 *
 * A field copy, and tested anyway: `isSource` is what the whole blind-spot half
 * of the report rests on. Taken from the wrong column it would read as "no shop
 * is a source", the report would say nothing is being missed, and — being a
 * diagnostic — that answer would be believed.
 */
export function listingsFrom(products: ListedProduct[]): Listing[] {
  return products.map((p) => ({
    shopName: p.shop.name,
    sku: p.sku,
    name: p.name,
    isSource: p.shop.stockSource,
    isActive: p.shop.active,
  }))
}
