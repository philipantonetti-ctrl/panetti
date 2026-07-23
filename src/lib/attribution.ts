import { db } from './db'

/**
 * Link orders that ALREADY carry this code to the ambassador.
 *
 * Attribution is normally stamped when an order is imported, so orders that
 * arrived before a code existed were frozen with no ambassador — which is why a
 * brand new ambassador saw nothing despite months of real sales on their code.
 * Every order still stores the coupon it used, so the link can be made after
 * the fact from data we already hold.
 *
 * Scoped to the code's own store, and only orders with NO ambassador yet are
 * touched: an attribution already frozen onto an order is history and is never
 * rewritten. Returns how many past orders were linked.
 */
export async function attributeExistingOrders(
  ambassadorId: string,
  shopId: string,
  code: string,
): Promise<number> {
  const { count } = await db.order.updateMany({
    where: { shopId, couponCode: code.toUpperCase(), ambassadorId: null },
    data: { ambassadorId },
  })
  return count
}
