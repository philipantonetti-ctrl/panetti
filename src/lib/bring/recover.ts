import { db } from '../db'

/** Import rows whose refusal list is read per cron tick. Database only, no network. */
export const RECOVER_PER_RUN = 10

/** A Bring package number as the warehouse file prints one; same shape import.ts stores as UNKNOWN. */
const BRING_SHAPED = /^[34]73\d{15}$/

export type RecoverResult = { imports: number; recovered: number }

/**
 * Refusals the importer used to throw away.
 *
 * Until 2026-09-11 a consignment the email rule refused was written down
 * only as a line in the import's `unmatched` JSON: the number, Bring's name
 * for the recipient, the reason. No Shipment row, so nothing could ever try
 * it again - and the rules have changed since: an order holding another
 * consignment's parcel is no longer a candidate, cancelled orders are not
 * either, and the window is longer when the short one is empty. Measured
 * that day: 82 such parcels in three weeks of files, 57 of them a repeat
 * customer's whose older order now holds its own parcel.
 *
 * Each import's list is read once. Every Bring-shaped number with no row is
 * stored as UNKNOWN and due now, and the poller identifies it (Bring first,
 * then DHL) and attaches it under today's rules, exactly as if the file had
 * arrived today. Numbers of other shapes are other carriers' and are left
 * where they are. The import is stamped so its list is never read twice, and
 * a number that already has a row is never touched.
 */
export async function recoverDroppedRefusals(
  opts: { now?: Date; limit?: number } = {},
): Promise<RecoverResult> {
  const now = opts.now ?? new Date()
  const due = await db.trackingImport.findMany({
    where: { unmatched: { not: null }, recoveredAt: null },
    orderBy: { receivedAt: 'asc' },
    take: opts.limit ?? RECOVER_PER_RUN,
    select: { id: true, unmatched: true },
  })

  let recovered = 0
  for (const imp of due) {
    let rows: unknown = []
    try {
      rows = JSON.parse(imp.unmatched ?? '[]')
    } catch {
      // Not a list we can read; stamped below so it is not tried every tick.
    }
    const numbers = new Set<string>()
    for (const r of Array.isArray(rows) ? rows : []) {
      const n = r && typeof r === 'object' && 'trackingNumber' in r ? String((r as { trackingNumber: unknown }).trackingNumber) : ''
      if (BRING_SHAPED.test(n)) numbers.add(n)
    }
    for (const trackingNumber of numbers) {
      // skipDuplicates on the unique tracking number: a row that exists, in
      // whatever state, is left exactly as it is.
      const r = await db.shipment.createMany({
        data: [{ trackingNumber, carrier: 'UNKNOWN', nextPollAt: now }],
        skipDuplicates: true,
      })
      recovered += r.count
    }
    await db.trackingImport.update({ where: { id: imp.id }, data: { recoveredAt: now } })
  }
  return { imports: due.length, recovered }
}
