import { unwrap } from './purchase-orders'
import { vismaGetPages } from './pages'
import type { VismaCredentials } from './client'

/** One file Visma holds for a purchase order, and the document it hangs off. */
export type PoFile = {
  /** Visma's attachment id; `GET /v1/attachment/{id}` serves the file. */
  id: string
  name: string
  /** The supplier invoice the file is attached to. */
  invoice: string
  invoiceDate: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Row = Record<string, unknown>
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()

export const isAttachmentId = (id: string): boolean => UUID.test(id)

/**
 * The PO number a row should show. A Visma row stored before `poNumber`
 * existed still has it inside its `orderNbr-lineNbr` id until the next import
 * fills the column, so it is read from there rather than shown blank.
 */
export function poNumberOf(o: { poNumber: string | null; externalId: string | null }): string | null {
  if (o.poNumber?.trim()) return o.poNumber.trim()
  if (!o.externalId) return null
  const cut = o.externalId.lastIndexOf('-')
  return cut > 0 ? o.externalId.slice(0, cut) : null
}

/**
 * The files Visma holds for one purchase order.
 *
 * NOT the PO's own files: Visma's API has none. `PurchaseOrderDto` carries no
 * `attachments` and there is no `purchaseorder/{nbr}/attachment` route (read
 * from Visma's OpenAPI document 2026-10-22). The documents that DO carry files
 * and name a PO are supplier invoices - every invoice line has `poNumber` - so
 * those are what a row's "Files" opens.
 *
 * Matched here on every row, exactly, never trusted to the query: Visma answers
 * an ignored filter with 200 and the wrong rows.
 */
export function filesForPo(invoices: unknown[], poNumber: string): PoFile[] {
  const wanted = poNumber.trim()
  const out: PoFile[] = []
  const seen = new Set<string>()

  for (const inv of rows(invoices)) {
    const lines = rows(inv.invoiceLines).filter((l) => str(l.poNumber) === wanted)
    if (lines.length === 0) continue

    const invoice = str(inv.referenceNumber)
    const date = str(inv.date).slice(0, 10)
    for (const a of [...rows(inv.attachments), ...lines.flatMap((l) => rows(l.attachments))]) {
      const id = str(a.id)
      if (!UUID.test(id) || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: str(a.name) || 'file',
        invoice,
        invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      })
    }
  }
  return out
}

/**
 * Where the search starts: a month before the order. A deposit is sometimes
 * invoiced as the order is placed, and a few days of clock skew between the
 * two documents must not hide it.
 */
export function poFilesSince(orderedAt: Date): string {
  return new Date(orderedAt.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Read the supplier invoices that could belong to this order and keep the
 * files of the ones that do.
 *
 * `item=` narrows the read to invoices for this product. If Visma ever ignored
 * it the read only gets wider, never wrong, because `filesForPo` checks the PO
 * number on every row. `complete` is false when the read hit its page ceiling,
 * so the page can say the list may be short instead of implying it is all.
 */
export async function findPoFiles(
  creds: VismaCredentials,
  { poNumber, sku, orderedAt }: { poNumber: string; sku: string; orderedAt: Date },
): Promise<{ files: PoFile[]; complete: boolean }> {
  const q = new URLSearchParams({
    item: sku,
    docDate: poFilesSince(orderedAt),
    docDateCondition: '>',
    expandAttachment: 'true',
  })
  const read = await vismaGetPages(creds, `controller/api/v1/supplierinvoice?${q}`, {
    pageSize: 500,
    maxPages: 4,
  })
  return { files: filesForPo(read.rows, poNumber), complete: read.complete }
}
