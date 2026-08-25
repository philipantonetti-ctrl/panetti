/**
 * How a hand-entered order is identified.
 *
 * B2B orders carry their own sequence - B-0001, B-0002 - rather than borrowing
 * the webshop's numbers, and their `externalId` is namespaced `b2b:`. A
 * WooCommerce `externalId` is always `String(woo.id)`, plain digits, so the
 * `@@unique([shopId, externalId])` that the sync and the webhook upsert on can
 * never match a hand-entered order and overwrite it.
 */
import { db } from '../db'

const PREFIX = 'B-'
const PAD = 4

/** 7 -> "B-0007". Past four digits it simply gets longer; nothing wraps. */
export function formatB2bNumber(n: number): string {
  return PREFIX + String(n).padStart(PAD, '0')
}

/** "B-0007" -> 7. Anything that is not ours -> 0, so it loses every max(). */
export function parseB2bNumber(number: string): number {
  if (!number.startsWith(PREFIX)) return 0
  const digits = number.slice(PREFIX.length)
  if (!/^\d+$/.test(digits)) return 0
  return Number(digits)
}

export function b2bExternalId(number: string): string {
  return `b2b:${number}`
}

/**
 * The next number for this shop.
 *
 * Reads every B2B number the shop holds and takes the highest, rather than
 * `orderBy: { number: 'desc' }` - string ordering puts "B-9999" above
 * "B-10000" and would hand back a number already taken. These are typed by
 * hand, so the list is small enough that reading it costs nothing.
 *
 * Call inside the transaction that writes the order. Two saves racing still
 * collide on `@@unique([shopId, externalId])`; the caller retries once.
 */
export async function nextB2bNumber(shopId: string): Promise<string> {
  const rows = await db.order.findMany({
    where: { shopId, b2bCustomerId: { not: null } },
    select: { number: true },
  })

  const highest = rows.reduce((best, r) => Math.max(best, parseB2bNumber(r.number)), 0)
  return formatB2bNumber(highest + 1)
}
