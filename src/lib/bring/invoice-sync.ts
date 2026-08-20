import { db } from '../db'
import type { BringCredentials, BringFilter } from './client'
import { listCustomerNumbers, listInvoices } from './invoices'

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
