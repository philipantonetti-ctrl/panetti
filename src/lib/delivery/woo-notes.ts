/**
 * Sending a matched parcel's tracking link back to the webshop.
 *
 * The moment a parcel is linked to an order - by the warehouse file, by the
 * Bring email match, or by the DHL file - whoever opens that order in
 * WooCommerce should be able to see where it is without going through us. This
 * writes that link into the order's PRIVATE notes: staff read it, the customer
 * never sees it and is never emailed.
 *
 * Deliberately its own stage rather than a call inside the three linkers. They
 * disagree about almost everything - one reads a spreadsheet, one asks Bring
 * for an email address, one reads a DHL export - and they agree about exactly
 * this: they set `Shipment.orderId`. A queue keyed on that fact covers all
 * three at once, survives a store being down without holding up an import, and
 * has one place to look when a note does not appear.
 */
import { db } from '../db'
import { decryptSecret } from '../secrets'
import { createOrderNote, WooError, type WooCredentials } from '../woo/client'
import { carrierName, trackingUrl } from './tracking-url'

/**
 * The private note a parcel becomes in its WooCommerce order.
 *
 * Two lines, and the number appears twice on purpose: outside the URL it is
 * the value support quotes on the phone and pastes into the carrier's own
 * site, and a note that is only a link hides it.
 *
 * One line only when trackingUrl has no page for this carrier - UNKNOWN
 * included, which a person can link to an order by hand before the poller has
 * identified it. Without this guard the second line was the literal text
 * "null", posted to a live order for staff and no one else to read.
 */
export function trackingNoteText(carrier: string, trackingNumber: string): string {
  const name = carrierName(carrier)
  const url = trackingUrl(trackingNumber, carrier)
  return url ? `${name} ${trackingNumber}\n${url}` : `${name} ${trackingNumber}`
}

export type WooNoteResult = {
  posted: number
  /** Parcels whose note the store refused this run, whether or not it will be retried. */
  failed: number
}

/**
 * How many notes one run may write. Notes are cheap - one small POST each,
 * against stores we already page orders out of - but a cap is what stops a
 * shop switched on with a large backlog from spending the whole cron run here.
 * What is left keeps its place and goes first next time.
 */
const MAX_NOTES_PER_RUN = 50

/** Enough of a store's complaint to act on, and never a whole error page. */
const ERROR_LIMIT = 300

export async function postWooTrackingNotes(
  opts: { deadline?: number; maxNotes?: number } = {},
): Promise<WooNoteResult> {
  const max = opts.maxNotes ?? MAX_NOTES_PER_RUN
  const none = { posted: 0, failed: 0 }
  if (max <= 0) return none

  // Only shops someone has switched on AND that we hold keys for. Both halves
  // matter: the date is the switch, and a shop with no keys must be passed
  // over in silence rather than counted as a failure on every parcel.
  const configured = await db.shop.findMany({
    where: {
      wooNotesFrom: { not: null },
      wooUrl: { not: null },
      wooKey: { not: null },
      wooSecret: { not: null },
    },
    select: { id: true, wooNotesFrom: true, wooUrl: true, wooKey: true, wooSecret: true },
  })

  const creds = new Map<string, WooCredentials>()
  const from = new Map<string, Date>()
  for (const s of configured) {
    if (!s.wooNotesFrom || !s.wooUrl || !s.wooKey || !s.wooSecret) continue
    try {
      creds.set(s.id, { url: s.wooUrl, key: decryptSecret(s.wooKey), secret: decryptSecret(s.wooSecret) })
      from.set(s.id, s.wooNotesFrom)
    } catch {
      // AUTH_SECRET changed since this shop was connected. The shops page
      // already says so - "Saved keys can't be read. Reconnect this shop." -
      // and a note nobody asked for is not the place to say it a second time.
    }
  }
  if (creds.size === 0) return none

  /**
   * The queue. `wooNoteAt: null` is the work, and the cutoff is compared
   * against the PARCEL's own createdAt so switching a shop on cannot reach
   * backwards into what is already stored.
   *
   * One OR arm per shop rather than one query per shop: the cap belongs to the
   * run, not to each store, so the oldest waiting parcels have to be picked
   * across all of them at once.
   */
  const due = await db.shipment.findMany({
    where: {
      wooNoteAt: null,
      orderId: { not: null },
      OR: [...from].map(([shopId, since]) => ({
        createdAt: { gte: since },
        // b2bCustomerId null is "this order came from the webshop". A B2B
        // order - typed by hand or imported from Visma - has no WooCommerce
        // order behind it, and its externalId is ours or Visma's invoice
        // number. Posting one would ask a live store for an id it has never
        // heard of.
        order: { shopId, b2bCustomerId: null },
      })),
    },
    orderBy: { createdAt: 'asc' },
    take: max,
    select: {
      id: true,
      trackingNumber: true,
      carrier: true,
      order: { select: { externalId: true, shopId: true } },
    },
  })

  let posted = 0
  let failed = 0

  for (const parcel of due) {
    // Checked before the request, not after: a post we have no time to finish
    // would still write the note and lose the answer, and the parcel would be
    // posted again next run.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break

    const order = parcel.order
    const shopCreds = order && creds.get(order.shopId)
    if (!order || !shopCreds) continue

    try {
      const noteId = await createOrderNote(
        shopCreds,
        order.externalId,
        trackingNoteText(parcel.carrier, parcel.trackingNumber),
      )
      await db.shipment.update({
        where: { id: parcel.id },
        data: { wooNoteAt: new Date(), wooNoteId: noteId, wooNoteError: null },
      })
      posted++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      /**
       * 404 is the store saying that order is not there - trashed, deleted, or
       * belonging to a different site than the keys do. Nothing about that
       * changes on its own, so the parcel is stamped and leaves the queue with
       * the reason kept. Every other status is a store having a bad minute:
       * the stamp stays null, and it is first in line next run.
       */
      const gone = err instanceof WooError && err.status === 404
      await db.shipment
        .update({
          where: { id: parcel.id },
          data: {
            wooNoteError: message.slice(0, ERROR_LIMIT),
            ...(gone ? { wooNoteAt: new Date() } : {}),
          },
        })
        .catch(() => {
          // Recording why is never worth failing the run over. The parcel keeps
          // its place either way.
        })
    }
  }

  return { posted, failed }
}
