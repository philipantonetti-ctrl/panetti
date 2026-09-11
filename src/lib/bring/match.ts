import { db } from '../db'
import { nameKey } from '../delivery/name-key'

/** How far before the parcel's booking an order may have been placed, first try. */
export const MATCH_WINDOW_DAYS = 30

/**
 * Second try, only when the first finds nothing at all.
 *
 * Measured 2026-09-11 on the "No order for <email>" refusals of three weeks:
 * nine of ten were Mazzetti chairs ordered 35 to 70 days before they
 * shipped, each the customer's only open order. Reached only when the short
 * window is empty, so no match the short window makes can change; and it is
 * still exactly one order or nothing. The premise it rests on: an order the
 * customer placed in the last four months, not cancelled, with no parcel on
 * record, is still waiting for its parcel.
 */
export const LONG_WINDOW_DAYS = 120

/**
 * Orders that will never ship. `voidedAt` covers only some of them: on
 * 2026-09-11 the tracked shops held 713 cancelled orders in 120 days and
 * 250 of those were voided, so a cancelled duplicate stayed a live candidate
 * and turned a repeat customer's parcel into "matched 2 orders".
 */
export const DEAD_STATUSES = ['cancelled', 'refunded', 'failed', 'trash']

const DAY = 24 * 60 * 60 * 1000

/** How many candidate order numbers a refusal spells out before it says "and others". */
const CANDIDATES_NAMED = 4

export type MatchOutcome = { orderId: string } | { orderId: null; reason: string }

/**
 * What the caller knows about the parcel beyond its email.
 *
 * `bookedAt` is when the label was made. An order placed after that cannot be
 * the one the label is for, so it replaces the file's arrival time as the
 * upper bound when known. `consignmentId` is the carrier's id for the whole
 * consignment: an order already holding a parcel from ANOTHER consignment is
 * not a candidate, while one holding this consignment's first box still is.
 */
export type MatchScope = { bookedAt?: Date | null; consignmentId?: string | null }

/**
 * The clauses both matchers share: a delivery-tracked shop, placed within the
 * window before the parcel was booked (or the file arrived), not cancelled in
 * either of the two ways an order can be, and not already holding a parcel
 * from another consignment.
 */
function candidateWhere(upper: Date, scope: MatchScope, windowDays: number) {
  /**
   * "Holds a parcel from another consignment". A held parcel with no
   * consignment id recorded (rows written before the column existed) counts
   * as another consignment: the rule can then only refuse, never wrongly
   * accept, which is the side a wrong link must always land on.
   */
  const heldByAnother = scope.consignmentId
    ? { OR: [{ consignmentId: null }, { consignmentId: { not: scope.consignmentId } }] }
    : {}
  return {
    shop: { deliveryTrackingFrom: { not: null } },
    placedAt: {
      gte: new Date(upper.getTime() - windowDays * DAY),
      lte: upper,
    },
    voidedAt: null,
    status: { notIn: DEAD_STATUSES },
    NOT: { shipments: { some: heldByAnother } },
  }
}

/**
 * The short window first; the long one only when the short one is empty.
 * Returns the orders found and the window they were found in, so the reason
 * can say which.
 */
async function findCandidates(
  where: (windowDays: number) => Record<string, unknown>,
): Promise<{ orders: { id: string; number: string }[]; days: number }> {
  const query = (days: number) =>
    db.order.findMany({
      where: where(days),
      select: { id: true, number: true },
      // One is enough to link and two are enough to refuse, so the extra rows
      // buy nothing but the refusal's WORDS. They are worth the read: "matched
      // 2 orders" sends the reader back to us to find out which two, and a
      // repeat customer is the ordinary case here rather than the exception.
      take: CANDIDATES_NAMED + 1,
      // Oldest first, which is both the order a person checks them in and what
      // makes the message stable between runs.
      orderBy: { placedAt: 'asc' },
    })
  const short = await query(MATCH_WINDOW_DAYS)
  if (short.length > 0) return { orders: short, days: MATCH_WINDOW_DAYS }
  return { orders: await query(LONG_WINDOW_DAYS), days: LONG_WINDOW_DAYS }
}

/** "4 or more" and "and others" once the list runs past what is spelled out. */
function describe(orders: { number: string }[]): { count: string; list: string } {
  const overflowed = orders.length > CANDIDATES_NAMED
  const named = orders.slice(0, CANDIDATES_NAMED).map((o) => o.number)
  return {
    count: overflowed ? `${CANDIDATES_NAMED} or more` : String(orders.length),
    list: overflowed ? `${named.join(', ')} and others` : named.join(', '),
  }
}

/**
 * Find the order a parcel belongs to, from the recipient email Bring returns.
 *
 * The warehouse's own `Order` column cannot do this job. It is their internal
 * counter - Bring carries it as `senderReference` - and it happens to fall in
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
 * to an order the same customer placed AFTER it shipped. When the caller knows
 * the booking time it is used instead - see MatchScope.
 */
export async function matchByEmail(
  email: string | null,
  receivedAt: Date,
  scope: MatchScope = {},
): Promise<MatchOutcome> {
  if (!email) return { orderId: null, reason: 'Bring holds no email for this parcel' }

  const upper = scope.bookedAt ?? receivedAt

  const { orders, days } = await findCandidates((windowDays) => ({
    customerEmail: { equals: email, mode: 'insensitive' },
    ...candidateWhere(upper, scope, windowDays),
  }))

  if (orders.length === 0) return { orderId: null, reason: `No order for ${email}` }
  if (orders.length > 1) {
    // Never claims a total it did not actually count. `take` above stops one
    // past the point we are willing to list, so a longer run is described as
    // longer rather than reported as exactly the number we happened to fetch.
    const { count, list } = describe(orders)
    return {
      orderId: null,
      reason: `${email} matched ${count} orders in the last ${days} days: ${list}`,
    }
  }
  return { orderId: orders[0].id }
}

export type NameScope = MatchScope & { country?: string | null }

/**
 * Find the order a parcel belongs to from the name on its label.
 *
 * Second choice after the email, and the only choice for DHL, which returns
 * no recipient at all. The warehouse prints the label from the order, so the
 * two names are the same name; nameKey folds the spelling. Measured on 90
 * linked parcels on 2026-09-11: 90 folded equal, 90 unique in the window.
 *
 * Same refusal rule as the email: two candidates are refused, not resolved.
 * The country, when the caller knows it, is one more thing that must agree;
 * when it is unknown (a number no carrier has answered for yet) the name
 * alone decides, which the measurement above also covered.
 */
export async function matchByName(
  name: string | null,
  receivedAt: Date,
  scope: NameScope = {},
): Promise<MatchOutcome> {
  const key = nameKey(name)
  if (!key) return { orderId: null, reason: 'The label carries no name' }
  const label = (name ?? '').trim()
  const upper = scope.bookedAt ?? receivedAt
  const country = scope.country?.trim().toUpperCase() || null

  const { orders, days } = await findCandidates((windowDays) => ({
    customerNameKey: key,
    ...(country ? { shippingCountry: { equals: country, mode: 'insensitive' } } : {}),
    ...candidateWhere(upper, scope, windowDays),
  }))

  const where = country ? ` in ${country}` : ''
  if (orders.length === 0)
    return { orderId: null, reason: `The label says ${label} and no order in the last ${days} days has that name${where}` }
  if (orders.length > 1) {
    const { count, list } = describe(orders)
    return { orderId: null, reason: `The label says ${label} and ${count} orders in the last ${days} days have that name${where}: ${list}` }
  }
  return { orderId: orders[0].id }
}
