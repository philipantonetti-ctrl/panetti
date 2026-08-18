import { db } from '../db'
import { normaliseSku } from '../inventory/sku'
import { vismaCredentials, vismaGet, VismaError } from './client'
import { mapVismaOrders, receiptDatesByNumber, unwrap } from './purchase-orders'
import { isWebshopAccount, mapReceivables } from './receivables'
import { COUNTED_WAREHOUSES, mapVismaStock } from './stock'
import type {
  VismaCustomerDocument,
  VismaInventoryItem,
  VismaOrder,
  VismaReceipt,
} from './types'

/**
 * One page, wide. Measured 2026-08-14: the company holds 227 purchase orders and
 * 208 receipts in its entire history, so this reads everything in one request
 * each and needs no date filter.
 *
 * If Visma ever returns exactly this many, the page is full and orders beyond it
 * were silently dropped — which would look identical to a company that simply
 * has no more. That case reports itself; see `truncated` below. The fix when it
 * fires is paging, not a bigger number.
 */
export const PAGE_SIZE = 500

export type VismaImportResult = {
  configured: boolean
  read: number
  imported: number
  skipped: { reason: string; count: number }[]
  /** True when the page came back full, so orders may have been missed. */
  truncated: boolean
  error: string | null
}

const nothing = (over: Partial<VismaImportResult> = {}): VismaImportResult => ({
  configured: true,
  read: 0,
  imported: 0,
  skipped: [],
  truncated: false,
  error: null,
  ...over,
})

/**
 * Pull purchase orders from Visma into our own table.
 *
 * Never throws. The scheduled sync calls this alongside the store pull, and
 * Visma being down must never fail that — the next run simply tries again.
 *
 * Idempotent: every row is keyed on Visma's `orderNbr-lineNbr`, so a re-run
 * updates rather than duplicates. Rows someone typed here have no externalId and
 * are invisible to this function.
 */
export async function importVismaPurchaseOrders(): Promise<VismaImportResult> {
  const creds = vismaCredentials()
  // Not an error. A deployment without Visma credentials is a normal deployment.
  if (!creds) return nothing({ configured: false })

  try {
    const orders = await vismaGet<VismaOrder[]>(
      creds,
      `controller/api/v1/purchaseorder?pageSize=${PAGE_SIZE}`,
    )
    const rows = Array.isArray(orders) ? orders : []

    // Receipts only date the finished orders. Losing them must not lose the
    // orders themselves, so this failing degrades to lastModifiedDateTime
    // rather than failing the import.
    let receiptDates = new Map<string, Date>()
    try {
      const receipts = await vismaGet<VismaReceipt[]>(
        creds,
        `controller/api/v1/purchasereceipt?pageSize=${PAGE_SIZE}`,
      )
      receiptDates = receiptDatesByNumber(Array.isArray(receipts) ? receipts : [])
    } catch {
      // Dates degrade; the import continues.
    }

    const items = await db.supplyItem.findMany({ select: { id: true, sku: true } })
    // normaliseSku, not a hand-rolled trim/uppercase: the mapper keys on it too,
    // and two spellings of "the same SKU" would fail to join for no visible reason.
    const idBySku = new Map(items.map((i) => [normaliseSku(i.sku), i.id]))

    const mapped = mapVismaOrders(rows, new Set(idBySku.keys()), receiptDates)

    let imported = 0
    for (const row of mapped.orders) {
      const supplyItemId = idBySku.get(row.sku)
      // mapVismaOrders already filtered to our SKUs, so this cannot normally miss.
      if (!supplyItemId) continue

      const fields = {
        supplyItemId,
        quantity: row.quantity,
        receivedQuantity: row.receivedQuantity,
        orderedAt: row.orderedAt,
        eta: row.eta,
        receivedAt: row.receivedAt,
      }

      await db.purchaseOrder.upsert({
        where: { externalId: row.externalId },
        create: { externalId: row.externalId, ...fields },
        // `notes` is deliberately absent: someone may have written one here, and
        // Visma has no opinion about it.
        update: fields,
      })
      imported += 1
    }

    return nothing({
      read: mapped.read,
      imported,
      skipped: mapped.skipped,
      truncated: rows.length >= PAGE_SIZE,
    })
  } catch (e) {
    // Reported, not thrown. The sync route shows this and the next run retries.
    return nothing({ error: e instanceof Error ? e.message : 'Visma import failed' })
  }
}

/**
 * One page, wide. Visma reports `maxPageSize: 5000` and the company holds 482
 * inventory items, so this reads the lot in a single request.
 *
 * Same trap as PAGE_SIZE above: a response of exactly this many is a full page,
 * and the SKUs beyond it would be indistinguishable from a company that owns no
 * more. `truncated` reports that rather than leaving it to be discovered.
 */
export const INVENTORY_PAGE_SIZE = 5000

export type VismaStockResult = {
  configured: boolean
  /** Inventory records Visma returned, stock items and everything else. */
  read: number
  /** Rows written, which is only the stock items in a counted warehouse. */
  stored: number
  removed: number
  truncated: boolean
  error: string | null
}

const noStock = (over: Partial<VismaStockResult> = {}): VismaStockResult => ({
  configured: true,
  read: 0,
  stored: 0,
  removed: 0,
  truncated: false,
  error: null,
  ...over,
})

/**
 * Pull the warehouse count from Visma into our own table.
 *
 * Never throws, for the same reason the purchase-order import does not: the
 * scheduled sync calls both, and Visma having a bad morning must not take the
 * store pull down with it. A failed run leaves the previous snapshot in place
 * and the forecast keeps using it.
 *
 * Written as a SNAPSHOT — one transaction that clears the table and refills it —
 * rather than 414 upserts and a prune. It is one round trip instead of hundreds
 * against a database in another country, it is atomic so no reader ever catches
 * the table half-empty, and it makes a SKU disappearing from Visma disappear
 * here too, which upserting alone would never do.
 */
export async function importVismaStock(): Promise<VismaStockResult> {
  const creds = vismaCredentials()
  if (!creds) return noStock({ configured: false })

  try {
    const items = await vismaGet<VismaInventoryItem[]>(
      creds,
      `controller/api/v1/inventory?pageSize=${INVENTORY_PAGE_SIZE}`,
    )
    const rows = Array.isArray(items) ? items : []
    const mapped = mapVismaStock(rows, COUNTED_WAREHOUSES)
    const truncated = rows.length >= INVENTORY_PAGE_SIZE

    // Nothing to write is not a reason to throw the snapshot away. An empty
    // page is far likelier to be Visma having a bad morning than the company
    // ceasing to own anything, and clearing on it would drop every product back
    // to the shop figure without a word.
    if (mapped.length === 0) return noStock({ read: rows.length, truncated })

    const [removed] = await db.$transaction([
      db.vismaStock.deleteMany({}),
      db.vismaStock.createMany({
        data: mapped.map((m) => ({
          sku: m.sku,
          quantityOnHand: m.quantityOnHand,
          available: m.available,
          measuredAt: m.measuredAt,
        })),
      }),
    ])

    return noStock({ read: rows.length, stored: mapped.length, removed: removed.count, truncated })
  } catch (e) {
    // Reported, not thrown. The sync route shows this and the next run retries.
    return noStock({ error: e instanceof Error ? e.message : 'Visma stock import failed' })
  }
}

/** Visma caps `customerdocument` at this, whatever larger number you ask for. */
export const RECEIVABLES_PAGE_SIZE = 1000

/**
 * A ceiling on the loop, not an expectation. Ten pages is ten thousand open
 * documents against a company that had a little over a thousand when this was
 * written — reaching it means something has gone wrong, and the run reports
 * itself partial rather than pretending it saw everything.
 */
const MAX_RECEIVABLE_PAGES = 10

/**
 * Between pages. Visma refuses at roughly ten calls in quick succession, and a
 * refused second page costs the whole run — so the pause is cheaper than the
 * retry it avoids.
 */
const PAGE_PAUSE_MS = 2_000

export type VismaReceivablesResult = {
  configured: boolean
  /** Documents Visma returned, before any of them were filtered out. */
  read: number
  /** Rows written: what is genuinely owed. */
  stored: number
  /**
   * Webshop house accounts dropped. Logged on every run precisely because the
   * filter is a name test — if those accounts are ever renamed this number
   * falls off a cliff, and a number that changes is noticed where silence is not.
   */
  excluded: number
  /** True when we did not get to the end. The previous snapshot is kept. */
  partial: boolean
  error: string | null
}

const noAr = (over: Partial<VismaReceivablesResult> = {}): VismaReceivablesResult => ({
  configured: true,
  read: 0,
  stored: 0,
  excluded: 0,
  partial: false,
  error: null,
  ...over,
})

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Pull Visma's open customer ledger into our own table.
 *
 * A SNAPSHOT, replaced whole in one transaction, so an invoice that has since
 * been paid stops appearing without anyone deleting anything. Never throws, for
 * the same reason the other two imports do not: the scheduled sync calls all
 * three and one ERP hiccup must not cost the store pull.
 *
 * **The partial read is the whole design problem here.** Unlike inventory and
 * purchase orders, this collection does not fit one request: `pageSize` caps at
 * 1000 and `pageNumber` is the only paging that works — `skip` is accepted and
 * silently returns page one again. Worse, the rate limit is a rolling window
 * that a burst exhausts for minutes: measured 2026-08-18, six consecutive
 * attempts at a single page with backoff of 20, 40, 60, 80, 100 and 120 seconds
 * were all refused.
 *
 * So a refusal partway through is expected, not exceptional, and it must not
 * replace the snapshot. Writing a half-read ledger would delete every invoice
 * living on the pages we never reached, and the finance page would quietly show
 * less debt than exists — the one error mode that must never happen here. A
 * partial run keeps yesterday's answer and says so; the next run tries again.
 */
export async function importVismaReceivables(): Promise<VismaReceivablesResult> {
  const creds = vismaCredentials()
  if (!creds) return noAr({ configured: false })

  try {
    const docs: VismaCustomerDocument[] = []
    let read = 0
    let partial = false

    for (let page = 1; page <= MAX_RECEIVABLE_PAGES; page++) {
      let batch: VismaCustomerDocument[]
      try {
        batch = await vismaGet<VismaCustomerDocument[]>(
          creds,
          `controller/api/v1/customerdocument?status=Open` +
            `&pageSize=${RECEIVABLES_PAGE_SIZE}&pageNumber=${page}`,
        )
      } catch (e) {
        // 429 only. Everything else is a real failure and is reported as one:
        // a 500 or a bad token is not something waiting fifteen minutes fixes,
        // and swallowing it would hide a broken integration behind a stale page.
        if (e instanceof VismaError && e.status === 429) {
          partial = true
          break
        }
        throw e
      }

      const rows = Array.isArray(batch) ? batch : []
      read += rows.length
      docs.push(...rows)

      // A short page is the end of the collection. A full one on the last
      // allowed page is not an end, it is a ceiling, and that is a partial read.
      if (rows.length < RECEIVABLES_PAGE_SIZE) break
      if (page === MAX_RECEIVABLE_PAGES) partial = true
      else await pause(PAGE_PAUSE_MS)
    }

    if (partial) return noAr({ read, partial: true })

    const mapped = mapReceivables(docs)
    const excluded = docs.filter((d) =>
      isWebshopAccount(String(unwrap<string>(d?.customer?.name) ?? '')),
    ).length

    // Emptying the table IS allowed here, unlike the stock snapshot: every
    // invoice being paid is a real state this page must be able to show, and a
    // guard against it would freeze a settled debt on screen forever. The read
    // is known complete by this line, which is what makes that safe.
    await db.$transaction([
      db.receivable.deleteMany({}),
      db.receivable.createMany({ data: mapped }),
    ])

    return noAr({ read, stored: mapped.length, excluded })
  } catch (e) {
    return noAr({ error: e instanceof Error ? e.message : 'Visma receivables import failed' })
  }
}
