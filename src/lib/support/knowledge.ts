import { db } from '@/lib/db'

/**
 * What the AI is allowed to know for THIS conversation.
 *
 * Scope first, then words. A Norwegian return policy must never be quoted to a
 * German customer, so anything scoped to another shop, country or language is
 * not merely ranked lower - it is not offered at all. A row with a null scope
 * applies everywhere, which is how the house tone of voice reaches every
 * ticket.
 *
 * The rules of the house are never filtered by words: instructions, tone,
 * things it must never say and situations that must always be escalated are
 * always included, because a rule that only appears when the customer happens
 * to mention it is not a rule.
 *
 * No embeddings, deliberately. At tens of policies and hundreds of answers,
 * scoping plus word overlap finds the right rows; a vector index would be
 * machinery earning nothing yet. Only this function changes when it stops
 * being true.
 */

export type KnowledgeScope = {
  shopId?: string | null
  country?: string | null
  language?: string | null
  skus?: string[]
}

/** Always sent, whatever the customer asked. The house rules. */
const ALWAYS = ['tone', 'instruction', 'never_say', 'always_escalate']

/** How many of the word-matched rows to carry. Enough to answer, short enough to read. */
const MAX_MATCHED = 12

const STOP = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'has', 'have', 'not', 'this', 'that',
  'jeg', 'har', 'ikke', 'min', 'mitt', 'och', 'att', 'det', 'som', 'der', 'die', 'und', 'ich',
  'ist', 'nicht', 'mein', 'hei', 'hej', 'hallo', 'hello', 'takk', 'tack', 'danke', 'thanks',
  // "A little" in Swedish, Norwegian and Danish. Also a massage chair model
  // ("Lite Comfort"), which a chat about "lite grejer" must not pull in.
  'lite', 'litt', 'lidt',
])

/**
 * What is left of a word after its ending is cut must be at least this long.
 * Three, because the head noun of a Nordic compound is often three letters:
 * the customer says ovnen or ugnen, the product is a pizzaovn or a pizzaugn.
 * A whole word still needs four letters to count at all.
 */
const STEM_MIN = 3

/**
 * The endings a noun takes in the shops' languages: the definite and plural
 * forms of Norwegian, Danish and Swedish (pizzaovnen, pizzaovnene, ugnarna),
 * the common Finnish cases (uunin, uunissa), the German and English plural
 * and genitive. Longest first; the first that leaves a keyword is the one cut.
 */
const ENDINGS = [
  'erne', 'arna', 'orna', 'erna',
  'ene', 'ane', 'ssa', 'ssä', 'sta', 'stä', 'lla', 'llä', 'lle', 'ksi',
  'en', 'et', 'er', 'ar', 'or', 'na', 'ne', 'es',
  's', 'n',
]

/**
 * The part of a word that survives inflection. "grader" becomes "grad" and
 * "pizzaovnen" becomes "pizzaovn", so a customer's form of a word finds the
 * page's form; the stem is a prefix of the word, so it can only find more.
 */
export function stemOf(word: string): string {
  for (const end of ENDINGS) {
    if (word.length - end.length >= STEM_MIN && word.endsWith(end)) return word.slice(0, -end.length)
  }
  return word
}

/** The words worth matching on: long enough to mean something, not stop words, cut to their stems. */
export function keywordsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-zæøåäöüß0-9-]{4,}/g) ?? []
  return [...new Set(words.filter((w) => !STOP.has(w)).map(stemOf))]
}

export type KnowledgeRow = {
  kind: string
  title: string
  body: string
  source: string
  sourceUrl: string | null
  /** Set on a website row: how its chunks are told apart and grouped into a page. */
  sourceKey?: string | null
}

/**
 * The most the pages of the products a question names may add to the prompt,
 * in characters. Every product page read so far fits inside it (the longest,
 * a massage chair, is 26,000), and two pages of the same chair in two colours
 * do not need to: the copy is the same.
 */
const PAGE_CHARS = 30_000

/** A website product row's key, and the part of it that names the page. */
const PRODUCT_KEY = /^(website:[^:]+:product:[^:]+):(\d+)$/

/**
 * The product's name as productRows() writes it on the first line of every
 * chunk, without a colour or size in brackets: "(Beige)" tells two listings
 * of one chair apart, it does not name a product a customer would ask for.
 */
const productNameOf = (body: string) =>
  body.match(/^Product: (.*)$/m)?.[1].replace(/\s*\([^)]*\)/g, '').toLowerCase() ?? ''

/** The part of a product chunk's key that names its page. */
const pageOf = (sourceKey: string | null | undefined) => sourceKey?.match(PRODUCT_KEY)?.[1] ?? null

/** How a shop's product pages sit in memory: one entry per page, its chunks in any order. */
type Page = { label: string; name: string; chunks: { n: number; row: KnowledgeRow }[] }

function pagesOf(rows: KnowledgeRow[]): Map<string, Page> {
  const pages = new Map<string, Page>()
  for (const row of rows) {
    const m = row.sourceKey?.match(PRODUCT_KEY)
    if (!m) continue
    const label = row.body.match(/^Product: (.*)$/m)?.[1] ?? ''
    const page = pages.get(m[1]) ?? { label, name: productNameOf(row.body), chunks: [] }
    page.chunks.push({ n: Number(m[2]), row })
    pages.set(m[1], page)
  }
  return pages
}

/**
 * The pages a word of the question names, most hits first.
 *
 * A word in more than a third of the shop's product names is the brand, or
 * the kind of thing the shop sells, not a product: it names none of them.
 */
function namedByWords(words: string[], pages: Map<string, Page>): string[] {
  const all = [...pages.entries()]
  const tooMany = Math.max(1, all.length / 3)
  const naming = words.filter((w) => {
    const hits = all.filter(([, p]) => p.name.includes(w)).length
    return hits > 0 && hits <= tooMany
  })
  return all
    .map(([key, p]) => ({ key, hits: naming.filter((w) => p.name.includes(w)).length }))
    .filter((p) => p.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((p) => p.key)
}

/**
 * The named pages, whole and in page order, inside the budget. A page is
 * read from the top and cut once where the budget ends, so what is kept
 * reads from the top.
 */
function pageRows(keys: string[], pages: Map<string, Page>): KnowledgeRow[] {
  const out: KnowledgeRow[] = []
  let chars = 0
  for (const key of keys) {
    for (const { row } of pages.get(key)!.chunks.sort((a, b) => a.n - b.n)) {
      if (chars + row.body.length > PAGE_CHARS) break
      chars += row.body.length
      out.push(row)
    }
  }
  return out
}

/**
 * Asked which of the shop's products the customer means: "hvor mange grader
 * kan den komme opp til?". Given the question and every page's key and
 * label; answers with the keys.
 */
export type PagePicker = (question: string, products: { key: string; name: string }[]) => Promise<string[]>

export async function knowledgeFor(text: string, scope: KnowledgeScope, deps: { pickPages?: PagePicker } = {}): Promise<KnowledgeRow[]> {
  // Null scope means "everywhere", so each filter admits rows that named this
  // shop/country/language AND rows that named none.
  //
  // Language is the one dimension left out when it is not given, rather than
  // narrowed to null-only like the rest: a shop or a country we do not know
  // is a fact we could get wrong (a Danish return window is not Germany's),
  // but a language we do not know yet - true of every turn before the model
  // has read the message - is not a fact at all, and the system prompt
  // already answers in the customer's own words regardless of which
  // language a policy was written in. Hiding it would only mean escalating
  // for no reason.
  const inScope = {
    active: true,
    AND: [
      { OR: [{ shopId: null }, ...(scope.shopId ? [{ shopId: scope.shopId }] : [])] },
      { OR: [{ country: null }, ...(scope.country ? [{ country: scope.country }] : [])] },
      ...(scope.language ? [{ OR: [{ language: null }, { language: scope.language }] }] : []),
      { OR: [{ sku: null }, ...(scope.skus?.length ? [{ sku: { in: scope.skus } }] : [])] },
    ],
  }

  const select = { kind: true, title: true, body: true, source: true, sourceUrl: true, sourceKey: true } as const

  // Fetched in its own query, with no ceiling: these four kinds are the house
  // rules, sent on every single ticket regardless of what was asked, so a row
  // in them must never be able to fall outside the window below - which the
  // daily website reads can now fill with hundreds of product rows newer than
  // any policy typed by hand.
  const [always, rest, products] = await Promise.all([
    db.knowledgeItem.findMany({
      where: { ...inScope, kind: { in: ALWAYS } },
      select,
      orderBy: { updatedAt: 'desc' },
    }),
    db.knowledgeItem.findMany({
      where: { ...inScope, kind: { notIn: ALWAYS } },
      select,
      orderBy: { updatedAt: 'desc' },
      // A ceiling on the read, not on the answer: the scoring below is what
      // decides, and it cannot score a row it never loaded.
      take: 400,
    }),
    // The shop's product pages, in their own query with no ceiling, like the
    // house rules. The window above is written in sync order, so once a shop
    // has more than 400 rows it would cut a page in the middle and the model
    // would read half a page with nothing to say so.
    scope.shopId
      ? db.knowledgeItem.findMany({
          where: { ...inScope, shopId: scope.shopId, source: 'website', sourceKey: { contains: ':product:' } },
          select,
        })
      : Promise.resolve([]),
  ])

  const words = keywordsOf(text)

  // The pages of the products the question is about go whole, first. The
  // picker is asked every time there are pages to pick from, because a
  // customer says "the oven", "it" or "kjøkkenmaskinen" on a Danish shop far
  // more often than "Pizzetta Pro", in any of six languages, and no word
  // list covers that. What it picks comes first; a word of the question can
  // still name a page on its own, which also carries a picker that failed.
  const pages = pagesOf(products)
  const picked = pages.size > 0 && deps.pickPages
    ? (await deps.pickPages(text, [...pages].map(([key, p]) => ({ key, name: p.label })))).filter((k) => pages.has(k))
    : []
  const keys = [...new Set([...picked, ...namedByWords(words, pages)])]
  const named = new Set(keys)
  const wholePages = pageRows(keys, pages)

  /**
   * Then the loose matches, from rows on no named page. A word in the TITLE
   * weighs three, in the body one. A product's long section otherwise
   * outranks the right product's short one by matching more words by
   * chance, now that website rows run to 1,500 characters.
   */
  const scored = rest
    .filter((r) => !named.has(pageOf(r.sourceKey) ?? ''))
    .map((r) => {
      const title = r.title.toLowerCase()
      const body = r.body.toLowerCase()
      const score = words.reduce((sum, w) => sum + (title.includes(w) ? 3 : body.includes(w) ? 1 : 0), 0)
      return { row: r, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED)
    .map((s) => s.row)

  return [...always, ...wholePages, ...scored]
}

const fromHost = (url: string | null) => {
  if (!url) return null
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The knowledge as the prompt sees it. Empty when there is none, and says so. */
export function knowledgeBlock(rows: KnowledgeRow[]): string {
  if (rows.length === 0) {
    return 'KNOWLEDGE BASE: empty. Nobody has written any policies or answers yet, so you have nothing to quote. Escalate anything that needs one.'
  }
  return [
    'KNOWLEDGE BASE. These are the only policies and answers you may state as ours:',
    ...rows.map((r) => {
      const host = r.source === 'website' ? fromHost(r.sourceUrl) : null
      return `[${r.kind}${host ? `, from ${host}` : ''}] ${r.title}\n${r.body}`
    }),
  ].join('\n\n')
}
