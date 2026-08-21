import { db } from '../db'
import { loadRates } from '../fx/rates'
import { buildRateTable } from '../metrics/fx'
import { getSetting } from '../settings'
import { monthlyInvoiceTotals, type InvoiceAmount } from './invoiced-cost'

/** The workspace currency and the stored rates, loaded once per run. */
async function displayFrame() {
  const [{ displayCurrency }, rows] = await Promise.all([getSetting(), loadRates()])
  return { currency: displayCurrency, rates: buildRateTable(rows) }
}

/**
 * Fill in what one carrier billed, per month, so nobody has to type it.
 *
 * One writer for every automatic source - Bring's invoice archive and the
 * company's own accounting alike - because the rules are the rules of the
 * MONTH, not of the carrier:
 *
 * Only months that have ENDED. A month still running has only some of its
 * invoices issued while its parcels keep arriving, so the figure would read
 * low and creep upward all month. A number that moves under the reader is
 * worse than one that lands a few days late.
 *
 * Never touches a row of a DIFFERENT source - above all one a person typed.
 * Someone who corrected a figure knows something the importer does not, and
 * silently overwriting that is the one behaviour that would make the whole
 * panel untrustworthy. Its own earlier rows are replaced freely, so a
 * re-issued invoice lands.
 */
export async function writeCarrierCosts(
  carrier: 'BRING' | 'DHL',
  source: 'bring' | 'visma',
  invoices: InvoiceAmount[],
  now = new Date(),
): Promise<number> {
  if (invoices.length === 0) return 0
  const { currency, rates } = await displayFrame()
  const thisMonth = now.toISOString().slice(0, 7)

  const totals = monthlyInvoiceTotals(invoices, currency, rates).filter((t) => t.month < thisMonth)

  let written = 0
  for (const total of totals) {
    const held = await db.carrierCost.findUnique({
      where: { carrier_month: { carrier, month: total.month } },
      select: { source: true },
    })
    if (held && held.source !== source) continue

    await db.carrierCost.upsert({
      where: { carrier_month: { carrier, month: total.month } },
      create: {
        carrier, month: total.month,
        amount: total.amountMinor, currency: total.currency, source,
      },
      update: { amount: total.amountMinor, currency: total.currency, source },
    })
    written += 1
  }
  return written
}
