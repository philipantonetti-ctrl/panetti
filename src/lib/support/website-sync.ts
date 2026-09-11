import { db } from '@/lib/db'
import type { CatalogEntry } from '@/lib/woo/client'
import { fetchPage, listPages, policyLike } from './website-pages'
import { sectionsOf, textOf } from './website-text'

/**
 * The shops' websites, read into the knowledge base.
 *
 * Products come from the catalogue sweep the Woo sync already runs, so no new
 * request goes to any shop for them; pages come from WordPress's public
 * pages API, only the ones a person ticked. Rows are upserted by a stable key
 * and deleted when their product or page is gone. A row a person turned off
 * stays off through every read, and a manual row is never touched.
 */

export const READ_AGAIN_AFTER_MS = 20 * 60 * 60 * 1000

export type ReadCounts = { products: number; withDescriptions: number; pages: number; rows: number }

type Row = { sourceKey: string; title: string; body: string; sourceUrl: string | null }

export function productRows(shopId: string, externalId: string, entry: CatalogEntry): Row[] {
  if (!entry.published) return []
  const name = textOf(entry.name)
  if (!name) return []

  const short = textOf(entry.shortDescription)
  const sections = [
    ...(short.length >= 40 ? [{ heading: null as string | null, text: short }] : []),
    ...sectionsOf(entry.description),
  ]
  const head = `Product: ${name}${entry.sku ? ` (SKU ${entry.sku})` : ''}${entry.permalink ? `\nPage: ${entry.permalink}` : ''}`

  return sections.map((s, n) => ({
    sourceKey: `website:${shopId}:product:${externalId}:${n}`,
    title: s.heading ? `${name} - ${s.heading}` : name,
    body: `${head}\n\n${s.text}`,
    sourceUrl: entry.permalink,
  }))
}

export function pageRows(
  shopId: string,
  page: { externalId: number; title: string; url: string; html: string },
): (Row & { sourceUrl: string })[] {
  const title = textOf(page.title) || page.url
  return sectionsOf(page.html).map((s, n) => ({
    sourceKey: `website:${shopId}:page:${page.externalId}:${n}`,
    title: s.heading ? `${title} - ${s.heading}` : title,
    body: `Page: ${page.url}\n\n${s.text}`,
    sourceUrl: page.url,
  }))
}

/**
 * The tick list. New pages are ticked when they read like a policy page,
 * never re-ticked afterwards: what a person set stays set.
 */
export async function syncPageInventory(shopId: string, siteUrl: string, opts: { deadline?: number } = {}): Promise<number> {
  const pages = await listPages(siteUrl, opts)
  for (const p of pages) {
    await db.websitePage.upsert({
      where: { shopId_externalId: { shopId, externalId: p.externalId } },
      create: { shopId, externalId: p.externalId, url: p.url, title: p.title, active: policyLike(p) },
      update: { url: p.url, title: p.title },
    })
  }
  return pages.length
}

export function dueForRead(shop: { websiteReadAt: Date | null }, now = new Date()): boolean {
  return shop.websiteReadAt === null || now.getTime() - shop.websiteReadAt.getTime() > READ_AGAIN_AFTER_MS
}

export async function refreshWebsiteKnowledge(input: {
  shopId: string
  siteUrl: string
  catalog: Map<string, CatalogEntry>
  deadline?: number
}): Promise<ReadCounts> {
  const { shopId } = input
  const now = new Date()
  const seen = new Set<string>()
  const rows: (Row & { kind: string })[] = []

  let withDescriptions = 0
  for (const [externalId, entry] of input.catalog) {
    const r = productRows(shopId, externalId, entry)
    if (r.length > 0) withDescriptions++
    for (const row of r) rows.push({ ...row, kind: 'product' })
  }

  let pages = 0
  try {
    const ticked = await db.websitePage.findMany({ where: { shopId, active: true }, select: { externalId: true } })
    for (const t of ticked) {
      if (input.deadline !== undefined && Date.now() >= input.deadline) break
      const page = await fetchPage(input.siteUrl, t.externalId, { deadline: input.deadline })
      if (!page) continue
      pages++
      for (const row of pageRows(shopId, { externalId: t.externalId, ...page })) rows.push({ ...row, kind: 'policy' })
    }
  } catch (e) {
    // The old rows stay. The error is shown on the settings line.
    const error = e instanceof Error ? e.message : 'Could not read the website'
    await db.shop.update({ where: { id: shopId }, data: { websiteError: error } }).catch(() => {})
    throw e
  }

  for (const row of rows) {
    seen.add(row.sourceKey)
    await db.knowledgeItem.upsert({
      where: { sourceKey: row.sourceKey },
      create: {
        kind: row.kind, title: row.title, body: row.body, shopId,
        source: 'website', sourceUrl: row.sourceUrl, sourceKey: row.sourceKey, readAt: now,
      },
      // Never `active`: a row a person turned off stays off.
      update: { kind: row.kind, title: row.title, body: row.body, sourceUrl: row.sourceUrl, readAt: now },
    })
  }
  await db.knowledgeItem.deleteMany({
    where: { shopId, source: 'website', sourceKey: { notIn: [...seen] } },
  })

  await db.shop.update({
    where: { id: shopId },
    data: { websiteReadAt: now, websiteProducts: input.catalog.size, websitePages: pages, websiteError: null },
  })

  return { products: input.catalog.size, withDescriptions, pages, rows: rows.length }
}
