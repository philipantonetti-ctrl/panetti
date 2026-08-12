import { db } from '../db'

/** How far before the file's arrival an order may have been placed. */
export const MATCH_WINDOW_DAYS = 30

const DAY = 24 * 60 * 60 * 1000

export type MatchOutcome = { orderId: string } | { orderId: null; reason: string }

/**
 * Find the order a parcel belongs to, from the recipient email Bring returns.
 *
 * The warehouse's own `Order` column cannot do this job. It is their internal
 * counter — Bring carries it as `senderReference` — and it happens to fall in
 * the same numeric range as Panetti Norway's order numbers, so every value
 * matches a real order and none of them match the right one. Measured on the
 * 2026-08-11 sample: 0 of 27 correct. The recipient email scored 27 of 27.
 *
 * Two or more candidates are REFUSED, not resolved by taking the newest. This
 * is the same judgement link.ts:46 makes about an order number two shops share:
 * a wrong link poisons that order's delivery figure permanently and nobody ever
 * notices, while a refused one is listed on the delivery page with its reason.
 *
 * `receivedAt` is when the file reached us, NOT the file's own dispatch column.
 * Reading that column would put us back to parsing their table, which is the
 * dependency this path exists to remove. Receipt is a few hours after dispatch,
 * so the bound is looser but never wrong: it exists to stop a parcel attaching
 * to an order the same customer placed AFTER it shipped.
 */
export async function matchByEmail(
  email: string | null,
  receivedAt: Date,
): Promise<MatchOutcome> {
  if (!email) return { orderId: null, reason: 'Bring holds no email for this parcel' }

  const orders = await db.order.findMany({
    where: {
      customerEmail: { equals: email, mode: 'insensitive' },
      shop: { deliveryTrackingFrom: { not: null } },
      placedAt: {
        gte: new Date(receivedAt.getTime() - MATCH_WINDOW_DAYS * DAY),
        lte: receivedAt,
      },
      voidedAt: null,
    },
    select: { id: true },
    take: 2, // one is enough to link, two is enough to refuse
  })

  if (orders.length === 0) return { orderId: null, reason: `No order for ${email}` }
  if (orders.length > 1)
    return { orderId: null, reason: `${email} matched 2 orders in the last ${MATCH_WINDOW_DAYS} days` }
  return { orderId: orders[0].id }
}
