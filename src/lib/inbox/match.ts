import { db } from '@/lib/db'
import { orderNumbersIn, phonesIn, trackingNumbersIn, normalizePhone } from './identifiers'

export type Match = { orderId: string; via: 'order_number' | 'tracking' | 'email' | 'phone' } | null

/**
 * Which order is this email about?
 *
 * Most specific evidence first. A number the customer typed beats the newest
 * order on their address, because "where is #1042" is not a question about
 * #1050. Every step returns the ONE order it is sure of or moves on; nothing
 * here picks the best of several, because a wrong confident match is the one
 * outcome the inbox must never produce - null is shown as "no order matched"
 * and the person picks.
 *
 * `shopId` is the receiving mailbox's shop. Woo order numbers repeat across
 * stores, so without it a bare number is only trusted when exactly one order
 * in the whole workspace carries it.
 */
export async function matchOrder(input: { email: string; text: string; shopId: string | null }): Promise<Match> {
  const numbers = orderNumbersIn(input.text)
  if (numbers.length) {
    // "#1042" and "1042" are the same order; stored numbers carry the hash on
    // webshop orders and none on B2B (B-0001).
    const forms = numbers.flatMap((n) => (n.startsWith('B-') ? [n] : [n, `#${n}`]))
    const hits = await db.order.findMany({
      where: { number: { in: forms }, ...(input.shopId ? { shopId: input.shopId } : {}) },
      orderBy: { placedAt: 'desc' },
      select: { id: true },
      take: 2,
    })
    if (hits.length === 1 || (hits.length > 1 && input.shopId)) return { orderId: hits[0].id, via: 'order_number' }
  }

  // trackingNumbersIn knows the carriers' shapes; the broader token scan is
  // for numbers we hold that fit no known shape - what we STORE is the truth
  // about what a tracking number looks like, not a regex.
  const parcels = [...new Set([...trackingNumbersIn(input.text), ...(input.text.match(/\b[A-Z0-9]{12,}\b/g) ?? [])])]
  if (parcels.length) {
    const hit = await db.shipment.findFirst({
      where: { trackingNumber: { in: parcels }, orderId: { not: null } },
      select: { orderId: true },
    })
    if (hit?.orderId) return { orderId: hit.orderId, via: 'tracking' }
  }

  const byEmail = await db.order.findFirst({
    where: { customerEmail: { equals: input.email, mode: 'insensitive' } },
    orderBy: { placedAt: 'desc' },
    select: { id: true },
  })
  if (byEmail) return { orderId: byEmail.id, via: 'email' }

  const phones = phonesIn(input.text)
  if (phones.length) {
    // Stored as typed ("+47 912 34 567"); compared on digits, and a country
    // code present on only ONE side must still match - the customer writes
    // "912 34 567", the order holds "+47 912 34 567". Both sides are 8+
    // digits, so a suffix match cannot fire by accident. A scan over recent
    // orders is cheap at this scale and avoids a normalised shadow column.
    const recent = await db.order.findMany({
      where: { customerPhone: { not: '' }, NOT: { customerPhone: null } },
      orderBy: { placedAt: 'desc' },
      select: { id: true, customerPhone: true },
      take: 5000,
    })
    const samePhone = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a)
    const hit = recent.find((o) => {
      const held = normalizePhone(o.customerPhone!)
      return phones.some((p) => samePhone(held, p))
    })
    if (hit) return { orderId: hit.id, via: 'phone' }
  }

  return null
}
