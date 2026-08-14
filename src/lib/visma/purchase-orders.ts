import { normaliseSku } from '../inventory/sku'
import type { VismaOrder, VismaReceipt, VismaReceiptRef } from './types'

export type { VismaOrder, VismaOrderLine, VismaReceipt, VismaReceiptRef } from './types'

export type MappedOrder = {
  externalId: string
  sku: string
  /** What was ordered. Never the outstanding amount — see the design doc. */
  quantity: number
  /** What Visma says has landed. Subtracted at the one place that counts arrivals. */
  receivedQuantity: number
  orderedAt: Date
  eta: Date | null
  /** Non-null means finished, which is what takes it out of the incoming set. */
  receivedAt: Date | null
}

export type SkipReason =
  | 'cancelled order'
  | 'order on hold'
  | 'cancelled line'
  | 'not our product'
  | 'unusable line'

export type MapResult = {
  orders: MappedOrder[]
  read: number
  skipped: { reason: SkipReason; count: number }[]
}

/** Visma wraps most scalars as `{ value: x }` — but not all of them. */
export function unwrap<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value
    return inner === null || inner === undefined ? null : (inner as T)
  }
  return v as T
}

const num = (v: unknown): number | null => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const date = (v: unknown): Date | null => {
  const raw = unwrap<string>(v)
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

const truthy = (v: unknown): boolean => unwrap<boolean>(v) === true

/** Receipt number to the date the goods were booked in. */
export function receiptDatesByNumber(receipts: VismaReceipt[]): Map<string, Date> {
  const map = new Map<string, Date>()
  for (const r of receipts ?? []) {
    const nbr = String(unwrap<string>(r?.receiptNbr) ?? '').trim()
    const d = date(r?.date)
    if (nbr && d) map.set(nbr, d)
  }
  return map
}

/**
 * The date an order actually finished.
 *
 * The latest of its receipts, because an order delivered in two shipments is
 * done when the last one lands. Falls back to `lastModifiedDateTime` for the
 * seven closed orders that carry no receipt at all, and to the order date if
 * even that is missing — all three are real dates Visma recorded, which is why
 * the page labels the column "recorded" rather than "received".
 *
 * Never the clock. `lastModifiedDateTime` alone would have been badly wrong:
 * orders 500023-500025 were received in November 2023 and last modified in July
 * 2026.
 */
function finishedOn(
  order: VismaOrder,
  receiptDates: Map<string, Date>,
  orderedAt: Date,
): Date {
  const refs = unwrap<VismaReceiptRef[]>(order.purchaseReceipts)
  let latest: Date | null = null
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      const nbr = String(
        unwrap<string>(ref?.receiptNumber) ?? unwrap<string>(ref?.receiptNbr) ?? '',
      ).trim()
      const d = nbr ? receiptDates.get(nbr) : undefined
      if (d && (latest === null || d > latest)) latest = d
    }
  }
  return latest ?? date(order.lastModifiedDateTime) ?? orderedAt
}

/**
 * Visma purchase orders, as rows we can store.
 *
 * One line becomes one row. `quantity` is always what was ordered and
 * `receivedQuantity` always what Visma says has landed, because a single column
 * holding "outstanding" would read as zero on a finished order and the page
 * could never show what arrived. The subtraction happens once, in load.ts.
 *
 * Completion is `line.completed`, NOT a quantity comparison. Visma closes orders
 * without booking receipts against them — 59 closed lines in the live company
 * have fewer receipts than they ordered, and order 500148 has none at all. A
 * quantity test leaves those counting as incoming stock forever.
 *
 * Every skip is counted with its reason. A line dropped silently because its SKU
 * did not match is indistinguishable from a line that never existed, and that is
 * exactly how a missing purchase order goes unnoticed.
 */
export function mapVismaOrders(
  orders: VismaOrder[],
  ourSkus: Set<string>,
  receiptDates: Map<string, Date> = new Map(),
): MapResult {
  const wanted = new Set([...ourSkus].map((s) => normaliseSku(s)))
  const out: MappedOrder[] = []
  const counts = new Map<SkipReason, number>()
  let read = 0

  const skip = (reason: SkipReason, n = 1) => counts.set(reason, (counts.get(reason) ?? 0) + n)

  for (const order of orders ?? []) {
    const lines = order.lines ?? []
    read += lines.length

    const status = String(unwrap<string>(order.status) ?? '').toLowerCase()

    if (status === 'cancelled' || status === 'canceled') {
      skip('cancelled order', lines.length)
      continue
    }

    // An order on hold has not been placed with the supplier. Counting it would
    // push a run-out date out on stock that may never be ordered — the same
    // reason an order with no ETA moves no date.
    if (status === 'hold' || truthy(order.hold)) {
      skip('order on hold', lines.length)
      continue
    }

    const orderedAt = date(order.date)
    const orderNbr = unwrap<string | number>(order.orderNbr)
    // No order date means no honest orderedAt, and orderedAt is not nullable.
    if (!orderedAt || orderNbr === null) {
      skip('unusable line', lines.length)
      continue
    }

    const orderEta = date(order.promisedOn)
    const finished = finishedOn(order, receiptDates, orderedAt)

    for (const line of lines) {
      // Checked before `completed`, because a cancelled line carries
      // completed: true as well.
      if (truthy(line.canceled)) {
        skip('cancelled line')
        continue
      }

      const rawSku = unwrap<string>(line.inventory?.number)
      const lineNbr = num(line.lineNbr)
      const ordered = num(line.orderQty)
      if (!rawSku || lineNbr === null || ordered === null || ordered <= 0) {
        skip('unusable line')
        continue
      }

      const sku = normaliseSku(rawSku)
      if (!wanted.has(sku)) {
        skip('not our product')
        continue
      }

      out.push({
        externalId: `${orderNbr}-${lineNbr}`,
        sku,
        quantity: ordered,
        receivedQuantity: Math.max(0, num(line.qtyOnReceipts) ?? 0),
        orderedAt,
        // The line's own promise beats the order's: a container of two products
        // can land on two different days.
        eta: date(line.promised) ?? orderEta,
        receivedAt: truthy(line.completed) ? finished : null,
      })
    }
  }

  return {
    orders: out,
    read,
    skipped: [...counts].map(([reason, count]) => ({ reason, count })),
  }
}
