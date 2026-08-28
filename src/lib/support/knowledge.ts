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
])

/** The words worth matching on: long enough to mean something, not stop words. */
export function keywordsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-zæøåäöüß0-9-]{4,}/g) ?? []
  return [...new Set(words.filter((w) => !STOP.has(w)))]
}

export type KnowledgeRow = {
  kind: string
  title: string
  body: string
}

export async function knowledgeFor(text: string, scope: KnowledgeScope): Promise<KnowledgeRow[]> {
  // Null scope means "everywhere", so each filter admits rows that named this
  // shop/country/language AND rows that named none.
  const inScope = {
    active: true,
    AND: [
      { OR: [{ shopId: null }, ...(scope.shopId ? [{ shopId: scope.shopId }] : [])] },
      { OR: [{ country: null }, ...(scope.country ? [{ country: scope.country }] : [])] },
      { OR: [{ language: null }, ...(scope.language ? [{ language: scope.language }] : [])] },
      { OR: [{ sku: null }, ...(scope.skus?.length ? [{ sku: { in: scope.skus } }] : [])] },
    ],
  }

  const rows = await db.knowledgeItem.findMany({
    where: inScope,
    select: { kind: true, title: true, body: true },
    orderBy: { updatedAt: 'desc' },
    // A ceiling on the read, not on the answer: the scoring below is what
    // decides, and it cannot score a row it never loaded.
    take: 400,
  })

  const words = keywordsOf(text)
  const always = rows.filter((r) => ALWAYS.includes(r.kind))
  const rest = rows.filter((r) => !ALWAYS.includes(r.kind))

  const scored = rest
    .map((r) => {
      const haystack = `${r.title} ${r.body}`.toLowerCase()
      return { row: r, score: words.filter((w) => haystack.includes(w)).length }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED)
    .map((s) => s.row)

  return [...always, ...scored]
}

/** The knowledge as the prompt sees it. Empty when there is none, and says so. */
export function knowledgeBlock(rows: KnowledgeRow[]): string {
  if (rows.length === 0) {
    return 'KNOWLEDGE BASE: empty. Nobody has written any policies or answers yet, so you have nothing to quote. Escalate anything that needs one.'
  }
  return [
    'KNOWLEDGE BASE. These are the only policies and answers you may state as ours:',
    ...rows.map((r) => `[${r.kind}] ${r.title}\n${r.body}`),
  ].join('\n\n')
}
