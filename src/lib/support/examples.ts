import { db } from '@/lib/db'

/**
 * A correction becomes an example the assistant can find next time.
 *
 * Until now a correction was stored and read by nobody: the review page kept
 * "what it should have said" beside the answer and nothing downstream ever
 * looked. This writes it where retrieval looks - a KnowledgeItem of kind
 * `example`, title = the customer's question, body = the corrected answer,
 * scoped to the shop and language of the conversation it came from. The
 * existing keyword overlap in knowledgeFor() surfaces it for a similar
 * question, and the prompt tells the model to follow a matching example.
 *
 * The conversation row keeps the correction too, as the record of what was
 * typed and when.
 */

/** KnowledgeItem.title is what the retrieval matches on; the question is cut to fit. */
const TITLE_LIMIT = 200

export async function promoteCorrection(
  conversationId: string,
  correction: string,
): Promise<{ knowledgeItemId: string } | null> {
  const text = correction.trim()
  if (!text) return null

  const row = await db.aiConversation.findUnique({
    where: { id: conversationId },
    select: { question: true, shopId: true, language: true },
  })
  if (!row) return null

  const item = await db.knowledgeItem.create({
    data: {
      kind: 'example',
      title: row.question.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || 'Customer question',
      body: text,
      shopId: row.shopId,
      language: row.language,
    },
  })
  await db.aiConversation.update({
    where: { id: conversationId },
    data: { rating: 'bad', correction: text },
  })
  return { knowledgeItemId: item.id }
}
