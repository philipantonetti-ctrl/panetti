import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { utcDay } from '@/lib/dates'
import { EXCLUDED_STATUSES } from '@/lib/metrics/types'
import { zoneDayEndUtc, zoneDayStartUtc } from '@/lib/tz'

/**
 * "Which orders used this code, and which of them count?"
 *
 * Ambassadors compare our figure with the shop's own screens, and WooCommerce
 * counts a code's use the moment an order is placed, paid or not. Staff then
 * spent hours working out why "15" became "13". The answer is always an order
 * that never became a sale, so this lists every order with the code and says
 * plainly why each one does or does not count.
 *
 * The rule is the SAME list the sales and commission figures leave out
 * (EXCLUDED_STATUSES), never a copy of it: a check that disagreed with the
 * figures it explains would be worse than none.
 */

const REASONS: Record<(typeof EXCLUDED_STATUSES)[number], string> = {
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  failed: 'Payment failed',
  trash: 'Deleted in the shop',
  pending: 'Not paid',
  'on-hold': 'Waiting for payment',
}

export function orderVerdict(status: string): { counts: boolean; reason: string | null } {
  const s = status.toLowerCase()
  if ((EXCLUDED_STATUSES as readonly string[]).includes(s)) {
    return { counts: false, reason: REASONS[s as keyof typeof REASONS] }
  }
  return { counts: true, reason: null }
}

const LABELS: Record<string, string> = {
  pending: 'Pending payment',
  'on-hold': 'On hold',
  trash: 'Deleted',
}

/** The shop's status as a label: "on-hold" reads "On hold". */
export function statusLabel(status: string): string {
  const s = status.toLowerCase()
  if (LABELS[s]) return LABELS[s]
  const words = s.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export type CodeOrder = {
  id: string
  number: string
  date: string
  shop: string
  code: string | null
  status: string
  statusLabel: string
  counts: boolean
  reason: string | null
  /** Product value after discount, without VAT or shipping, in `currency` minor units. */
  sales: number
  currency: string
}

/** A list long enough for any real code and period, short enough to draw. */
export const CODE_ORDER_CAP = 1000

/**
 * Every order matching `where` placed in the period, newest first, each with
 * its verdict. Days are the workspace's days, as on every other figure.
 */
export async function loadCodeOrders(
  where: Prisma.OrderWhereInput,
  range: { from: Date; to: Date },
  timezone: string,
): Promise<CodeOrder[]> {
  const rows = await db.order.findMany({
    where: {
      ...where,
      placedAt: {
        gte: zoneDayStartUtc(utcDay(range.from).toISOString().slice(0, 10), timezone),
        lte: zoneDayEndUtc(utcDay(range.to).toISOString().slice(0, 10), timezone),
      },
    },
    orderBy: { placedAt: 'desc' },
    take: CODE_ORDER_CAP,
    select: {
      id: true,
      number: true,
      placedAt: true,
      status: true,
      couponCode: true,
      netSales: true,
      currency: true,
      shop: { select: { name: true } },
    },
  })

  return rows.map((o) => ({
    id: o.id,
    number: o.number,
    date: o.placedAt.toISOString(),
    shop: o.shop.name,
    code: o.couponCode,
    status: o.status,
    statusLabel: statusLabel(o.status),
    ...orderVerdict(o.status),
    sales: o.netSales,
    currency: o.currency,
  }))
}
