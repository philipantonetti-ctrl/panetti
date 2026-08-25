import type { AffiliateMarket } from './client'

/**
 * Which shop an Addrevenue market belongs to, decided by DOMAIN: the
 * advertiser's market URL against Shop.wooUrl. Exact or nothing - a market
 * with no matching shop is reported, never guessed from names. (Compare
 * src/lib/dhl/link.ts, which refuses unknown codes for the same reason.)
 */

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  const candidate = url.includes('://') ? url : `https://${url}`
  try {
    const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}

export function matchMarketsToShops(
  markets: AffiliateMarket[],
  shops: { id: string; wooUrl: string | null }[],
): { byMarket: Map<string, string>; unmatched: string[] } {
  const shopByHost = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const s of shops) {
    const host = hostOf(s.wooUrl)
    if (!host || ambiguous.has(host)) continue
    if (shopByHost.has(host)) {
      // Two shops on one host: picking either would be a guess, so the host
      // matches nothing and the market surfaces as unmatched instead.
      shopByHost.delete(host)
      ambiguous.add(host)
    } else {
      shopByHost.set(host, s.id)
    }
  }

  const byMarket = new Map<string, string>()
  const unmatched: string[] = []
  for (const m of markets) {
    const host = hostOf(m.url)
    const shopId = host ? shopByHost.get(host) : undefined
    if (shopId) byMarket.set(m.market, shopId)
    else unmatched.push(m.market)
  }
  return { byMarket, unmatched }
}
