import { db } from '../db'
import type { BringCredentials, BringFilter } from './client'
import { generateSpecReport, listCustomerNumbers, listInvoices } from './invoices'

/**
 * Turn every invoice we have not seen into a job.
 *
 * Cheap: one call to enumerate customers, one per customer to list invoices.
 * It writes nothing but rows, so a tick that discovers and then runs out of
 * time has still moved the work forward.
 */
export async function discoverInvoices(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<{ found: number; queued: number; noSpec: number }> {
  let found = 0
  let queued = 0
  let noSpec = 0

  for (const customerNumber of await listCustomerNumbers(creds, opts)) {
    for (const invoice of await listInvoices(creds, customerNumber, opts)) {
      found += 1
      // A row we already hold is left exactly as it is: it may be STORED, and
      // rediscovering an invoice must never send it round the loop again.
      const held = await db.bringReportRun.findUnique({
        where: { invoiceNumber: invoice.invoiceNumber },
        select: { id: true },
      })
      if (held) continue

      const state = invoice.specificationAvailable ? 'PENDING' : 'NO_SPEC'
      await db.bringReportRun.create({
        data: {
          customerNumber: invoice.customerNumber || customerNumber,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate,
          state,
        },
      })
      if (state === 'PENDING') queued += 1
      else noSpec += 1
    }
  }

  return { found, queued, noSpec }
}

/**
 * Ask Bring to build one report.
 *
 * Oldest first, the same fairness rule syncAllShops and syncShipments follow:
 * without it a run that cannot reach everything starves the same rows every
 * time, forever.
 *
 * Returns whether a row was worked on at all — a failure still counts, because
 * the tick did its one unit of work and the row now says why.
 */
export async function requestNextReport(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<boolean> {
  const next = await db.bringReportRun.findFirst({
    where: { state: 'PENDING' },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!next) return false

  try {
    const statusUrl = await generateSpecReport(creds, next.customerNumber, next.invoiceNumber, opts)
    await db.bringReportRun.update({
      where: { id: next.id },
      data: { state: 'REQUESTED', statusUrl, requestedAt: new Date(), error: null },
    })
  } catch (e) {
    // Stored, never thrown. One dead invoice must not stop the rest — the same
    // rule delivery/sync.ts follows for one dead parcel.
    await db.bringReportRun.update({
      where: { id: next.id },
      data: { state: 'FAILED', error: e instanceof Error ? e.message : String(e) },
    })
  }
  return true
}
