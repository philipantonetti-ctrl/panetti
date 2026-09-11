import { textOf } from './website-text'

/**
 * A shop's WordPress pages, through the public REST API. No key: the pages
 * are public, and all nine shops answered `wp/v2/pages` without one on
 * 2026-09-10. Products are NOT read here; they come from the WooCommerce
 * catalogue sweep the sync already runs (lib/woo/client.ts, fetchCatalog).
 */

export type ListedPage = { externalId: number; url: string; title: string; slug: string }

const REQUEST_TIMEOUT_MS = 20_000

const base = (siteUrl: string) => siteUrl.replace(/\/$/, '')
const host = (siteUrl: string) => new URL(siteUrl).host.replace(/^www\./, '')

function budget(opts: { deadline?: number }): number {
  const left = opts.deadline === undefined ? REQUEST_TIMEOUT_MS : opts.deadline - Date.now()
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, left))
}

async function get(siteUrl: string, path: string, opts: { deadline?: number }): Promise<unknown> {
  const res = await fetch(`${base(siteUrl)}${path}`, { signal: AbortSignal.timeout(budget(opts)) })
  if (!res.ok) throw new Error(`${host(siteUrl)} answered ${res.status}`)
  return res.json()
}

type RawPage = { id?: unknown; link?: unknown; slug?: unknown; title?: { rendered?: unknown }; content?: { rendered?: unknown } }

export async function listPages(siteUrl: string, opts: { deadline?: number } = {}): Promise<ListedPage[]> {
  const out: ListedPage[] = []
  for (let page = 1; page <= 5; page++) {
    const raw = (await get(siteUrl, `/wp-json/wp/v2/pages?per_page=100&page=${page}&_fields=id,link,slug,title`, opts)) as RawPage[]
    if (!Array.isArray(raw)) break
    for (const p of raw) {
      if (typeof p.id !== 'number' || typeof p.link !== 'string') continue
      out.push({
        externalId: p.id,
        url: p.link,
        title: textOf(String(p.title?.rendered ?? '')) || p.link,
        slug: typeof p.slug === 'string' ? p.slug : '',
      })
    }
    if (raw.length < 100) break
  }
  return out
}

export async function fetchPage(
  siteUrl: string,
  externalId: number,
  opts: { deadline?: number } = {},
): Promise<{ title: string; url: string; html: string } | null> {
  const raw = (await get(siteUrl, `/wp-json/wp/v2/pages?include=${externalId}&_fields=id,link,title,content`, opts)) as RawPage[]
  const p = Array.isArray(raw) ? raw[0] : undefined
  if (!p || typeof p.link !== 'string') return null
  return {
    title: textOf(String(p.title?.rendered ?? '')) || p.link,
    url: p.link,
    html: String(p.content?.rendered ?? ''),
  }
}

/** Words that mark a page as policy-like, in the six shop languages. */
export const POLICY_WORDS = [
  'terms', 'betingelser', 'villkor', 'vilkår', 'ehdot', 'bedingungen',
  'warranty', 'garanti', 'takuu', 'faq', 'shipping', 'levering', 'leverans', 'toimitus', 'versand',
  'returns', 'retur', 'palautus', 'rücksendung', 'delivery',
] as const

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Pre-ticked on first listing: a page whose slug or title carries a policy word. */
export function policyLike(page: { slug: string; title: string }): boolean {
  const hay = fold(`${page.slug} ${page.title}`)
  return POLICY_WORDS.some((w) => hay.includes(fold(w)))
}
