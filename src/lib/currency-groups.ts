import { NO_SHOPS } from '@/components/filters/ShopFilter'

/**
 * Adding two stores' money together is only honest when they trade in the same
 * currency. This is the rule the product page is gated on: `Shop` records a
 * currency and no country, and currency is what protects the arithmetic anyway
 * - Finland and Germany are different countries, both EUR, and EUR + EUR is
 * correct.
 */

export type ShopLike = { id: string; name: string; currency: string }

/** Grouped by currency, groups ordered by currency code so renders are stable. */
export function groupByCurrency<T extends ShopLike>(shops: T[]): { currency: string; shops: T[] }[] {
  const byCurrency = new Map<string, T[]>()
  for (const shop of shops) {
    const list = byCurrency.get(shop.currency) ?? []
    list.push(shop)
    byCurrency.set(shop.currency, list)
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, group]) => ({ currency, shops: group }))
}

/**
 * ShopFilter's selection vocabulary resolved to actual shops: empty means all
 * of them, the NO_SHOPS sentinel means none. An unknown id is dropped rather
 * than fabricated, so a stale URL cannot conjure a shop.
 */
export function selectedShops<T extends ShopLike>(shops: T[], selected: string[]): T[] {
  if (selected.includes(NO_SHOPS)) return []
  if (selected.length === 0) return shops
  return shops.filter((s) => selected.includes(s.id))
}
