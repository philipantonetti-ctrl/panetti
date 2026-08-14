/**
 * DHL parcels onto orders.
 *
 * Simpler than the Bring path on purpose. Bring's file gives only parcel
 * numbers, so that path asks the carrier for the recipient email and matches on
 * that. DHL's export already names the order, so the only real work here is
 * deciding WHICH SHOP the reference belongs to — order numbers are not unique
 * across shops, and Panetti Germany #15537 and Panetti Sweden #15537 are two
 * different customers.
 */
import { db } from '../db'
import type { DhlShipment } from './parse'
import type { UnmatchedRow } from '../bring/link'

/**
 * The country each site's code stands for.
 *
 * Listed rather than derived, so an unknown code is REFUSED instead of guessed
 * at. Shops are named "<Brand> <Country>", which is what lets a reference read
 * `Panetti.de` and find Panetti Germany without any mapping table for someone
 * to keep up to date.
 */
const COUNTRY: Record<string, string> = {
  de: 'Germany',
  se: 'Sweden',
  dk: 'Denmark',
  fi: 'Finland',
  no: 'Norway',
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** `panetti.de` into `Panetti Germany`, or null if the code is not one we know. */
export function shopNameForSite(site: string): string | null {
  const [brand, code] = site.split('.')
  if (!brand || !code) return null
  const country = COUNTRY[code.toLowerCase()]
  return country ? `${capitalise(brand)} ${country}` : null
}

export type DhlLinkResult = { linked: number; unmatched: UnmatchedRow[] }

/**
 * Write one Shipment per DHL parcel, attached to its order.
 *
 * `now` is when this file reached us, and it is the only honest delivery
 * timestamp the export can give — see the availableAt rule below.
 */
export async function linkDhlShipments(
  shipments: DhlShipment[],
  now: Date,
): Promise<DhlLinkResult> {
  const unmatched: UnmatchedRow[] = []
  let linked = 0

  for (const s of shipments) {
    const shopName = shopNameForSite(s.site)
    if (!shopName) {
      unmatched.push({
        orderNumber: s.orderNumber,
        trackingNumber: s.trackingNumber,
        reason: `${s.site} is not a shop we recognise`,
      })
      continue
    }

    // startsWith, not equals: a workspace may suffix a shop name, and the test
    // fixtures certainly do. take 2 so an ambiguous prefix refuses rather than
    // silently picking the first.
    const shops = await db.shop.findMany({
      where: {
        name: { startsWith: shopName, mode: 'insensitive' },
        deliveryTrackingFrom: { not: null },
      },
      select: { id: true },
      take: 2,
    })

    if (shops.length !== 1) {
      unmatched.push({
        orderNumber: s.orderNumber,
        trackingNumber: s.trackingNumber,
        reason:
          shops.length === 0
            ? `${shopName} is not delivery-tracked`
            : `${shopName} matched ${shops.length} shops`,
      })
      continue
    }

    const orders = await db.order.findMany({
      where: { shopId: shops[0].id, number: s.orderNumber },
      select: { id: true },
      take: 2,
    })

    if (orders.length !== 1) {
      unmatched.push({
        orderNumber: s.orderNumber,
        trackingNumber: s.trackingNumber,
        reason:
          orders.length === 0
            ? `No order ${s.orderNumber} in ${shopName}`
            : `Order ${s.orderNumber} matched ${orders.length} orders in ${shopName}`,
      })
      continue
    }

    const existing = await db.shipment.findUnique({
      where: { trackingNumber: s.trackingNumber },
      select: { availableAt: true, outcome: true, terminal: true },
    })

    const delivered = s.status.toUpperCase() === 'DELIVERED'

    /**
     * The delivery moment, and the one genuinely difficult call in this file.
     *
     * The export says a parcel IS delivered. It never says WHEN. So:
     *
     * - A parcel already delivered the first time we see it gets NO date. We
     *   did not watch it arrive and cannot honestly claim a day. A guess here
     *   would go straight into the delivery-time median and stay wrong forever,
     *   which is exactly the failure link.ts refuses for ambiguous orders.
     * - A parcel we already hold, which turns delivered in a later export, is
     *   stamped at the moment we learned. With a daily feed that is accurate to
     *   the day, and it is a real observation rather than an invention.
     * - A date already set is never moved, so re-importing an old file cannot
     *   rewrite history.
     *
     * The consequence, stated plainly: parcels delivered before the first
     * import are counted as still moving until DHL's tracking API fills their
     * dates in. Under-claiming is the right way to be wrong.
     */
    const availableAt =
      existing?.availableAt ?? (delivered && existing ? now : null)

    const link = {
      orderId: orders[0].id,
      carrier: 'DHL',
      linkSource: 'DHL_FILE',
      bookedAt: s.createdAt,
      handedInAt: s.pickupAt,
      availableAt,
      outcome: delivered ? 'DELIVERED' : (existing?.outcome ?? null),
      terminal: delivered ? true : (existing?.terminal ?? false),
      lastStatus: s.status,
      // Left alone deliberately. Nothing polls a DHL parcel yet, and setting a
      // due date would make the Bring poller ask Bring about a DHL number.
      nextPollAt: null,
    }

    await db.shipment.upsert({
      where: { trackingNumber: s.trackingNumber },
      create: { trackingNumber: s.trackingNumber, ...link },
      update: link,
    })
    linked++
  }

  return { linked, unmatched }
}
