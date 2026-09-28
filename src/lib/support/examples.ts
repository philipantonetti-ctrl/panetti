import { db } from '@/lib/db'
import { normalizePhone, orderNumbersIn, phonesIn, trackingNumbersIn } from '@/lib/inbox/identifiers'

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
/** A run of four or more digits, spaces, dots or dashes allowed inside: "15 209", "20 30 40 50". */
const LONG_NUMBER = /\d(?:[\s.-]?\d){3,}/g
/** An order reference with separators in the number, which orderNumbersIn does not read: "ordre 15.209". */
const SPACED_ORDER_REFERENCE =
  /(?:#|\b(?:order|ordre|ordrenummer|ordrenr|bestilling|bestillingsnummer|beställning|beställningsnummer|ordernummer|bestellung|bestellnummer|tilaus|tilausnumero)\b[\s:.#-]*)\d(?:[ .-]?\d){2,6}\b/i

/**
 * An example is offered to every later chat on its shop, so its title keeps
 * the question and loses the customer: the offline form's header, any email,
 * any number long enough to be an order.
 */
export function exampleTitle(question: string): string {
  return question
    .replace(OFFLINE_HEADER, '')
    .replace(EMAIL, ' ')
    .replace(LONG_NUMBER, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_LIMIT)
}

/** What identifies the customer a conversation was with, read from the orders on its email. */
export type CustomerMarks = { orderNumbers: string[]; phones: string[]; parcels: string[] }

/**
 * Whether a correction is about one customer rather than about the shop.
 * Such an answer ("order 15209 went in two parcels") is right for that
 * customer and a leak for everyone else, so it is kept on its row and taught
 * to nobody.
 *
 * Any order reference, parcel number or email outside the shops' own domains
 * counts; so does anything of THIS customer's - an order number, phone or
 * parcel on their orders, however it is spaced. The shop's own phone, a
 * postcode, a price or a model number does not: that is what the shop knows.
 */
export function namesACustomer(text: string, marks: CustomerMarks, shopDomains: string[]): boolean {
  const outside = (text.match(EMAIL) ?? []).some((address) => {
    const domain = address.split('@')[1].toLowerCase().replace(/[.,;:!?)]+$/, '')
    return !shopDomains.some((d) => domain === d || domain.endsWith(`.${d}`))
  })
  if (outside) return true
  if (orderNumbersIn(text).length > 0 || SPACED_ORDER_REFERENCE.test(text) || trackingNumbersIn(text).length > 0) return true

  const written = new Set((text.match(LONG_NUMBER) ?? []).map((n) => n.replace(/\D/g, '')))
  if (marks.orderNumbers.some((n) => written.has(n.replace(/\D/g, '')))) return true
  if (marks.parcels.some((p) => written.has(p.replace(/\D/g, '')) || text.includes(p))) return true
  const last8 = (n: string) => normalizePhone(n).slice(-8)
  const phones = phonesIn(text).map(last8)
  return marks.phones.some((p) => last8(p).length === 8 && phones.includes(last8(p)))
}

/** The customer's identifiers, from the orders on the conversation's email and its own order number. */
async function marksOf(email: string | null, orderNumber: string | null): Promise<CustomerMarks> {
  const orders = email
    ? await db.order.findMany({
        where: { customerEmail: { equals: email, mode: 'insensitive' } },
        select: { number: true, customerPhone: true, shipments: { select: { trackingNumber: true } } },
        take: 50,
      })
    : []
  return {
    orderNumbers: [...orders.map((o) => o.number), ...(orderNumber ? [orderNumber] : [])],
    phones: orders.map((o) => o.customerPhone).filter((p): p is string => Boolean(p)),
    parcels: orders.flatMap((o) => o.shipments.map((s) => s.trackingNumber)),
  }
}

/** The shops' own web domains, so an address like kundeservice@panetti.dk is shop knowledge. */
async function shopDomains(): Promise<string[]> {
  const shops = await db.shop.findMany({ where: { wooUrl: { not: null } }, select: { wooUrl: true } })
  return shops.flatMap((s) => {
    try {
      return [new URL(s.wooUrl as string).hostname.toLowerCase().replace(/^www\./, '')]
    } catch {
      return []
    }
  })
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
    select: { question: true, shopId: true, language: true, orderNumber: true, customerEmail: true },
  })
  if (!row) return null

  if (namesACustomer(text, await marksOf(row.customerEmail, row.orderNumber), await shopDomains())) {
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
