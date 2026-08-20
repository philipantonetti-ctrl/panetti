import { db } from '../db'
import type { BringCredentials, BringFilter } from './client'
import { linesReconcile, parseSpecifiedInvoice } from './invoice-lines'
import { downloadReport, generateSpecReport, listCustomerNumbers, listInvoices, reportStatus } from './invoices'

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

/**
 * Collect one requested report.
 *
 * Null means nothing was collected — nothing requested, or not ready yet —
 * which is a normal tick, not a problem.
 *
 * The invoice header is re-read here rather than remembered from discovery, so
 * a re-issued invoice reconciles against what it says today.
 */
export async function collectNextReport(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<{ stored: number; unmatched: number } | null> {
  const job = await db.bringReportRun.findFirst({
    where: { state: 'REQUESTED', statusUrl: { not: null } },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!job) return null

  const fail = async (message: string) => {
    await db.bringReportRun.update({
      where: { id: job.id },
      data: { state: 'FAILED', error: message },
    })
    return null
  }

  try {
    const status = await reportStatus(creds, job.statusUrl!, opts)
    if (!status.done) return null
    if (!status.xmlUrl) return fail('Bring built no report for this invoice')

    const parsed = parseSpecifiedInvoice(await downloadReport(creds, status.xmlUrl, opts))
    if (!parsed) return fail('The report could not be read as a specified invoice')

    const header = (await listInvoices(creds, job.customerNumber, opts)).find(
      (i) => i.invoiceNumber === job.invoiceNumber,
    )
    if (!header) return fail('The invoice is no longer in the archive')
    if (!linesReconcile(parsed, header)) {
      // Storing a half-read invoice is indistinguishable from a cheap month.
      return fail(
        `The report's lines do not reconcile with the invoice total (${header.amountMinor} minor units)`,
      )
    }

    // Wholesale replace. The report carries no line identifier, so this — not a
    // unique constraint — is what makes re-reading safe.
    const { count } = await db.$transaction(async (tx) => {
      await tx.shipmentCost.deleteMany({ where: { invoiceNumber: job.invoiceNumber } })
      return tx.shipmentCost.createMany({
        data: parsed.lines.map((l) => ({
          trackingNumber: l.waybillNumber,
          customerNumber: job.customerNumber,
          invoiceNumber: job.invoiceNumber,
          amount: l.amountMinor,
          currency: l.currency,
          chargedAt: l.chargedAt,
          itemNumber: l.itemNumber,
          description: l.description,
        })),
      })
    })

    // How much of this invoice we could not attach to a parcel we hold. Counted
    // rather than hidden: it is the number that says whether the join works.
    const known = await db.shipment.findMany({
      where: { trackingNumber: { in: [...new Set(parsed.lines.map((l) => l.waybillNumber))] } },
      select: { trackingNumber: true },
    })
    const have = new Set(known.map((s) => s.trackingNumber))
    const unmatched = parsed.lines.filter((l) => !have.has(l.waybillNumber)).length

    await db.bringReportRun.update({
      where: { id: job.id },
      data: {
        state: 'STORED', collectedAt: new Date(),
        rowsStored: count, rowsUnmatched: unmatched, error: null,
      },
    })
    return { stored: count, unmatched }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
