/**
 * DHL Freight's "Download shipment history" export, read into parcels.
 *
 * This is a different shape of problem from the Bring path, and deliberately a
 * different reader. Bring's file gives only parcel numbers, so that path asks
 * Bring who each parcel belongs to and matches on the recipient email. DHL's
 * export already carries OUR order number in a reference column, put there when
 * the warehouse booked the shipment, so no lookup is needed at all.
 *
 * Measured on the real 62-row export from 2026-08-15: 57 rows carry an order
 * number. Of the 5 that do not, 4 are genuinely not customer deliveries —
 * pallet freight (`DHL Road Freight Standard`, references like `LET19703987R`)
 * and inbound stock (`DHL Parti`, `PO: 223730`). They are reported, never
 * silently dropped.
 */
import { xlsxToRows } from './sheet'

export type DhlShipment = {
  /** The 10-digit DHL Shipment Number. A string, always. */
  trackingNumber: string
  /** Lower-cased, e.g. `panetti.de`. Says which shop sold it. */
  site: string
  /** Digits only, e.g. `15537`. Matches Order.number within that shop. */
  orderNumber: string
  /** DHL's own word: ORDERSENT | INTRANSIT | DELIVERED. Passed through. */
  status: string
  createdAt: Date | null
  pickupAt: Date | null
}

/** A row that carried no order number, so an operator can see what we passed over. */
export type DhlSkipped = { trackingNumber: string; reference: string; product: string }

export type DhlParse = { shipments: DhlShipment[]; skipped: DhlSkipped[] }

/**
 * Columns that together mean "this is a DHL export and not something else".
 * Chosen because no other file we accept has them.
 */
const REQUIRED = ['Shipment Number', 'Shipment Status', 'Sender Reference', 'Receiver Reference']

/**
 * `Panetti.de Order #15537`, and the shorthand `Panetti.de 15343` that appears
 * when whoever booked it left out the words.
 *
 * The country codes are listed rather than matched as `[a-z]{2}` so that a
 * freight reference can never be mistaken for an order. `Shipment: 026408`,
 * `LET19703987R`, `PO: 223730` and `1352-10264` all correctly fail this.
 */
const ORDER_REF = /\b([A-Za-z]+)\.(de|se|dk|fi|no)\b[^\d]*(\d+)/i

/** Excel counts days from 1899-12-30. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

function excelDate(raw: string): Date | null {
  const days = Number(raw)
  // Null rather than a guess. A missing pickup date is unknown, and inventing
  // one would put a fabricated number into the delivery-time median.
  if (!raw || !Number.isFinite(days) || days <= 0) return null
  return new Date(EXCEL_EPOCH_MS + days * DAY_MS)
}

type Ref = { site: string; orderNumber: string }

function readOrderRef(value: string): Ref | null {
  const m = ORDER_REF.exec(value ?? '')
  if (!m) return null
  return { site: `${m[1].toLowerCase()}.${m[2].toLowerCase()}`, orderNumber: m[3] }
}

/**
 * Read a DHL export, or return null if this file is not one.
 *
 * Null rather than a throw, so the caller can hand the same bytes to the Bring
 * reader instead: one inbound address takes both files and neither sender has
 * to know which parser will pick their message up.
 */
export function parseDhlExport(buf: Buffer): DhlParse | null {
  let rows: Record<string, string>[]
  try {
    rows = xlsxToRows(buf)
  } catch {
    return null
  }
  if (rows.length === 0) return null
  if (!REQUIRED.every((h) => h in rows[0])) return null

  const shipments: DhlShipment[] = []
  const skipped: DhlSkipped[] = []

  for (const row of rows) {
    const trackingNumber = (row['Shipment Number'] ?? '').trim()
    // Nothing to track and nothing to report: an empty trailing row is not an
    // event, and filing it as a refusal would cry wolf on every import.
    if (!trackingNumber) continue

    // BOTH columns, because a return swaps the parties: the customer becomes
    // the sender and our order number moves out of Receiver Reference.
    const receiver = row['Receiver Reference'] ?? ''
    const sender = row['Sender Reference'] ?? ''
    const ref = readOrderRef(receiver) ?? readOrderRef(sender)

    if (!ref) {
      skipped.push({
        trackingNumber,
        reference: receiver || sender,
        product: row['Product Name'] ?? '',
      })
      continue
    }

    shipments.push({
      trackingNumber,
      site: ref.site,
      orderNumber: ref.orderNumber,
      status: (row['Shipment Status'] ?? '').trim(),
      createdAt: excelDate(row['Creation Date (UTC)'] ?? ''),
      pickupAt: excelDate(row['Pickup Date'] ?? ''),
    })
  }

  return { shipments, skipped }
}
