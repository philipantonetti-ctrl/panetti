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

/** The widget's offline form puts its first field (often the email) and a line of dashes before the message. */
const OFFLINE_HEADER = /^[\s\S]*?-{10,}\s*/
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
/** An order, phone or parcel number. Four digits is a year or a model; five is somebody's. */
const PERSONAL_NUMBER = /\d{5,}|\+?\d[\d -]{6,}\d/

/**
 * An example is offered to every later chat on its shop, so its title keeps
 * the question and loses the customer: the offline form's header, any email,
 * any number long enough to be an order.
 */
export function exampleTitle(question: string): string {
  return question
    .replace(OFFLINE_HEADER, '')
    .replace(EMAIL, ' ')
    .replace(/\d{4,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_LIMIT)
}

/**
 * Whether a correction is about one customer rather than about the shop.
 * Such an answer ("order 15209 went in two parcels") is right for that
 * customer and a leak for everyone else, so it is kept on its row and taught
 * to nobody.
 */
export function namesACustomer(text: string, orderNumber: string | null): boolean {
  if (new RegExp(EMAIL.source).test(text) || PERSONAL_NUMBER.test(text)) return true
  return orderNumber !== null && orderNumber.length > 0 && text.includes(orderNumber)
}

export const WITHHELD =
  'It names a customer (an email, a phone, an order or a parcel number), so it is kept on this row and not taught to the assistant.'

export async function promoteCorrection(
  conversationId: string,
  correction: string,
): Promise<{ knowledgeItemId: string | null; withheld?: string } | null> {
  const text = correction.trim()
  if (!text) return null

  const row = await db.aiConversation.findUnique({
    where: { id: conversationId },
    select: { question: true, shopId: true, language: true, orderNumber: true },
  })
  if (!row) return null

  if (namesACustomer(text, row.orderNumber)) {
    await db.aiConversation.update({ where: { id: conversationId }, data: { rating: 'bad', correction: text } })
    return { knowledgeItemId: null, withheld: WITHHELD }
  }

  const item = await db.knowledgeItem.create({
    data: {
      kind: 'example',
      title: exampleTitle(row.question) || 'Customer question',
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
