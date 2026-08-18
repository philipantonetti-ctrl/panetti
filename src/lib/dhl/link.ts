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
      // nextPollAt is read so the file cannot overwrite a schedule the poller
      // has since decided — see the assignment below.
      select: { availableAt: true, outcome: true, terminal: true, nextPollAt: true },
    })

    const delivered = s.status.toUpperCase() === 'DELIVERED'

    /**
     * The delivery moment, which this file never supplies.
     *
     * The export says a parcel IS delivered. It never says WHEN. DHL's tracking
     * API does, to the second — so the file provides the fact and the API
     * provides the moment, and nothing here is stamped.
     *
     * This used to write `now` for a parcel that turned delivered in a later
     * export, described as "the moment we learned". That is a real observation
     * of the wrong thing: it then fed the delivery-time median as though it
     * were the moment the customer received the parcel, which is a different
     * and always later event. With a weekly file, or a backfill, it is days out.
     *
     * A date already set is never moved, so re-importing an old file cannot
     * rewrite what the poller observed.
     */
    const availableAt = existing?.availableAt ?? null

    const link = {
      orderId: orders[0].id,
      carrier: 'DHL',
      linkSource: 'DHL_FILE',
      bookedAt: s.createdAt,
      handedInAt: s.pickupAt,
      availableAt,
      outcome: delivered ? 'DELIVERED' : (existing?.outcome ?? null),
      /**
       * The file never ends a parcel's life. Only the poller does.
       *
       * `delivered ? true` here was the reason DHL's real delivery timestamps
       * could never arrive: syncShipments selects `terminal: false`, so a
       * parcel the file called delivered was removed from the poller's reach
       * permanently — and the comment above promising the API would fill its
       * date in was describing something this line prevented.
       *
       * Worse for a parcel already delivered the first time we saw it: no
       * availableAt, no poll, so it counted as still moving and sat in the late
       * list forever with nothing able to correct it.
       *
       * Left to the poller, one lookup writes the real availableAt, and
       * nextPollFor turns the parcel terminal itself — DHL's `delivered` maps
       * into COLLECTED, which is a full stop. One extra call per delivered
       * parcel, once, against a 240/day budget.
       */
      terminal: existing?.terminal ?? false,
      lastStatus: s.status,
      /**
       * The parcel's FIRST due date, and only its first.
       *
       * This used to be null on purpose: the poller asked Bring about every
       * number regardless of carrier, so a due date here would have sent a DHL
       * number to Bring. delivery/sync.ts now dispatches on `carrier`, so a DHL
       * parcel can finally be tracked — and without a due date the poller, which
       * selects on `nextPollAt: { lte: now }`, would never see it.
       *
       * Set to `now` so the next run picks it up, but only when the parcel has
       * none. After that the poller owns the schedule: re-importing yesterday's
       * file must not drag a parcel it has already tiered back to the front of
       * the queue, which under oldest-first ordering would starve the parcels
       * genuinely waiting.
       *
       * A delivered parcel gets `terminal: true` above and is never selected at
       * all, so this costs it nothing.
       */
      nextPollAt: existing?.nextPollAt ?? now,
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
