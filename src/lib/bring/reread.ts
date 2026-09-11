import { db } from '../db'
import { readLabels } from './labels'
import { attach, ATTACH_SELECT } from '../delivery/attach'

/**
 * The version of the rules a warehouse file is read with.
 *
 * Every import row stores the file it came from together with this number.
 * Bump it when the reader learns something new to take from a file - a
 * column it did not read before, a rule it did not apply - and the cron reads
 * every stored file again, on its own, over the following ticks. Nobody has
 * to find the files, and nobody has to upload anything twice.
 *
 * 1: the numbers only (until 2026-09-11). 2: the name on the label (column
 * Namn), which is what attaches a DHL parcel to its order.
 */
export const RULES_VERSION = 2

/** Files read again per cron tick. Each is a few database writes, no network. */
export const REREAD_PER_RUN = 10

export type RereadResult = { files: number; linked: number }

/**
 * Read stored files that an older rule set last read, and take from them
 * what the current rules can: today, the name on each label.
 *
 * Same promises as uploading the file by hand a second time: a parcel that
 * already has an order keeps it, a parcel a person dismissed stays dismissed,
 * a row that had no name learns it, and every unlinked row named here tries
 * to attach on the spot. Consignments are not asked of Bring again; the
 * poller owns that, and the numbers were stored on the first reading.
 */
export async function rereadStoredFiles(
  opts: { now?: Date; deadline?: number; limit?: number } = {},
): Promise<RereadResult> {
  const now = opts.now ?? new Date()
  const due = await db.trackingImport.findMany({
    where: { file: { not: null }, OR: [{ fileRules: null }, { fileRules: { lt: RULES_VERSION } }] },
    // Oldest first: the parcels that have waited longest are named first.
    orderBy: { receivedAt: 'asc' },
    take: opts.limit ?? REREAD_PER_RUN,
    select: { id: true, filename: true, file: true, namesRead: true },
  })

  let files = 0
  let linked = 0
  for (const rec of due) {
    // Checked before each file, so a tick with no time left reads nothing
    // rather than half a file.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    if (!rec.file) continue

    const labels = readLabels(Buffer.from(rec.file), rec.filename)
    let attached = 0
    if (labels) {
      for (const [number, name] of labels.names) {
        // A row that had no name learns it; a name a carrier or an earlier
        // file gave is never overwritten. Linked and dismissed rows learn it
        // too - a name is a fact about the parcel, not a link.
        await db.shipment.updateMany({
          where: { trackingNumber: number, recipientName: null },
          data: { recipientName: name },
        })
      }
      const rows = await db.shipment.findMany({
        where: { trackingNumber: { in: [...labels.names.keys()] }, orderId: null, dismissedAt: null },
        select: ATTACH_SELECT,
      })
      for (const row of rows) {
        const r = await attach(row)
        if (r.linked) attached++
      }
    }

    await db.trackingImport.update({
      where: { id: rec.id },
      data: {
        fileRules: RULES_VERSION,
        rereadAt: now,
        rereadLinked: attached,
        // The first reading's count stands when there was one; a file read
        // by the old numbers-only path gets its count now, on the importer's
        // own convention: 0 when this reader found no names in it.
        namesRead: rec.namesRead ?? (labels ? labels.rows : 0),
      },
    })
    files++
    linked += attached
  }
  return { files, linked }
}
