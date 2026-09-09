import { daysBetween } from '../delivery/days'
import { stillLate } from '../delivery/view'
import type { LoadedDelivery } from '../delivery/load'
import type { InventoryRow } from '../inventory/load'

/**
 * What needs doing today, for the operations manager.
 *
 * Four rules, one per card, and nothing else: given rows that already exist -
 * the delivery view, the inventory forecast, Visma's open ledger - which of
 * them is worth a person's morning, and in what order.
 *
 * Deliberately pure. No database, no browser, no money formatting (how an
 * amount is written is a workspace setting the page reads). Every rule is
 * borrowed rather than invented: the chase queue is `stillLate`, the same
 * function the Delivery tile and the Slack alert use, so this page cannot
 * quietly disagree with the tab it links to.
 */

/** How many rows a card shows. The count above it is always the true total. */
export const TASK_LIMIT = 5

const DAY = 24 * 60 * 60 * 1000

export type TaskRow = {
  /** Stable across a render, for React keys. */
  key: string
  /** The identifier a person recognises: an order number, a SKU, a customer. */
  label: string
  /** Who or what it belongs to. Null when there is nothing worth adding. */
  sub: string | null
  /** The one fact that makes it urgent. */
  detail: string
  /** Where clicking the row goes. */
  href: string
  /** Money, in minor units, for the rows that carry any. */
  amount?: { minor: number; currency: string }
}

export type TaskCard = {
  /**
   * The TRUE total, not `rows.length`. The rows are capped, and a heading that
   * reports its own cap is wrong exactly when the situation is worst.
   */
  total: number
  rows: TaskRow[]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The deep link the Delivery tab and the Slack alert both already use. */
const orderHref = (number: string) => `/orders?q=${encodeURIComponent(number)}`

function card(rows: TaskRow[], total: number): TaskCard {
  return { total, rows: rows.slice(0, TASK_LIMIT) }
}

/**
 * Parcels past their promise, still not with the customer, that somebody can
 * go and ask a carrier about. Worst first.
 */
export function lateParcels(loaded: LoadedDelivery[]): TaskCard {
  const chasable = loaded
    .filter((r) => stillLate(r.view))
    .sort((a, b) => (b.view.daysOver ?? 0) - (a.view.daysOver ?? 0))

  return card(
    chasable.map((r) => ({
      key: r.order.id,
      label: r.order.number,
      sub: r.customerName || null,
      detail: `${plural(r.view.daysOver ?? 0, 'day', 'days')} over`,
      href: orderHref(r.order.number),
    })),
    chasable.length,
  )
}

/**
 * Orders no warehouse file has said anything about: no parcel at all.
 *
 * A different job from the card above, and deliberately a different card. An
 * order with a late parcel is chased with the carrier; this one is chased with
 * the warehouse, and calling it "late" would assert a missed promise the data
 * cannot support. Longest wait first - most of these are still inside their
 * promise, so days-over would rank nothing.
 */
export function ordersWithNoParcel(loaded: LoadedDelivery[], now: Date, timezone: string): TaskCard {
  const waited = (r: LoadedDelivery) => daysBetween(r.order.placedAt, now, r.order.shopTimezone ?? timezone)

  const unfiled = loaded
    .filter((r) => r.view.state === 'NO_TRACKING')
    .sort((a, b) => waited(b) - waited(a))

  return card(
    unfiled.map((r) => ({
      key: r.order.id,
      label: r.order.number,
      sub: r.customerName || null,
      detail: `waiting ${plural(waited(r), 'day', 'days')}`,
      href: orderHref(r.order.number),
    })),
    unfiled.length,
  )
}

/**
 * Stock that needs a decision, in the order the decisions are urgent.
 *
 * Three reasons, each already worked out by the forecast, ranked by how little
 * time is left to act: an order-by date already in the past, then goods a
 * supplier should have delivered, then a stockout window a booked arrival will
 * eventually heal. One row per product, carrying its most urgent reason - a
 * SKU listed twice is one job, not two.
 */
export function stockToOrder(rows: InventoryRow[]): TaskCard {
  type Ranked = { row: TaskRow; group: number; within: number }

  const ranked: Ranked[] = []
  for (const r of rows) {
    const f = r.forecast
    const base = { key: r.sku, label: r.sku, sub: r.name, href: '/inventory' }

    if (f.daysLate !== null && f.daysLate > 0) {
      ranked.push({
        row: { ...base, detail: `order now, ${plural(f.daysLate, 'day', 'days')} late` },
        group: 0,
        // Most overdue first.
        within: -f.daysLate,
      })
    } else if (f.overdueArrivals) {
      ranked.push({
        row: { ...base, detail: `${f.overdueArrivals.quantity} units overdue from the supplier` },
        group: 1,
        // Waiting longest first.
        within: f.overdueArrivals.since.getTime(),
      })
    } else if (f.gap) {
      const empty = Math.round((f.gap.until.getTime() - f.gap.from.getTime()) / DAY)
      ranked.push({
        row: { ...base, detail: `runs empty for ${plural(empty, 'day', 'days')}` },
        group: 2,
        // Soonest first.
        within: f.gap.from.getTime(),
      })
    }
  }

  ranked.sort((a, b) => a.group - b.group || a.within - b.within)
  return card(
    ranked.map((r) => r.row),
    ranked.length,
  )
}

/** One open document from Visma's ledger, as this page needs to read it. */
export type ReceivableTask = {
  referenceNumber: string
  customerName: string
  /** Null when Visma reported none. Such a document can never be overdue. */
  dueDate: Date | null
  currency: string
  /** Minor units. Positive is owed to us; a credit note is negative. */
  balance: number
}

/**
 * Customers past their due date with money still outstanding, worst first.
 *
 * A missing due date is its own answer and never an overdue invoice - Visma
 * leaves the field off some documents, and treating those as due today would
 * invent a debt out of a blank field. Same reading as the Receivables tab.
 */
export function overdueInvoices(rows: ReceivableTask[], now: Date): TaskCard {
  const overdue = rows
    .filter((r) => r.dueDate !== null && r.dueDate.getTime() < now.getTime() && r.balance > 0)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())

  return card(
    overdue.map((r) => ({
      key: r.referenceNumber,
      label: r.customerName,
      sub: r.referenceNumber,
      detail: `${plural(Math.floor((now.getTime() - r.dueDate!.getTime()) / DAY), 'day', 'days')} overdue`,
      href: '/finance',
      amount: { minor: r.balance, currency: r.currency },
    })),
    overdue.length,
  )
}

/** The newest warehouse file, as this page needs to read it. Null when none has arrived. */
export type WarehouseImport = {
  filename: string
  receivedAt: Date
  rowsParsed: number
  rowsLinked: number
  rowsUnmatched: number
  /** Why the whole file was refused. Null when it was read. */
  error: string | null
} | null

/**
 * What went wrong with the parcel feed, if anything.
 *
 * Three problems, worst first: the file was refused outright, some of its rows
 * found no order, or parcels are sitting in the database attached to nothing.
 *
 * The last one earns its place because it is invisible everywhere else: a
 * parcel holding no order appears on no order's row and in no late list, so a
 * linking outage looks exactly like a quiet week. A card that is empty here
 * means last night's file arrived and every parcel found its order, which is
 * the fact an operations manager wants before he starts.
 */
export function warehouseProblems(latest: WarehouseImport, unlinkedParcels: number): TaskCard {
  const rows: TaskRow[] = []

  if (latest?.error) {
    rows.push({
      key: 'import-error',
      label: 'Last file failed',
      sub: latest.filename,
      detail: latest.error,
      href: '/delivery',
    })
  }

  if (latest && latest.rowsUnmatched > 0) {
    rows.push({
      key: 'import-unmatched',
      label: `${plural(latest.rowsUnmatched, 'row', 'rows')} not matched to an order`,
      sub: latest.filename,
      detail: 'the file named an order we do not hold',
      href: '/delivery',
    })
  }

  if (unlinkedParcels > 0) {
    rows.push({
      key: 'unlinked',
      label: `${plural(unlinkedParcels, 'parcel', 'parcels')} linked to no order`,
      sub: null,
      detail: 'invisible on every other screen',
      href: '/delivery',
    })
  }

  return card(rows, rows.length)
}
