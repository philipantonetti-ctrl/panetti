import { orderTotals } from '../b2b/pricing'
import { db } from '../db'
import { normaliseSku } from '../inventory/sku'
import {
  mapVismaB2bSales,
  type LinkedCustomers,
  type MappedB2bOrder,
} from './b2b-sales'
import { vismaCredentials, vismaGet, VismaError } from './client'
import { mapVismaOrders, receiptDatesByNumber, unwrap } from './purchase-orders'
import { isWebshopAccount, mapReceivables } from './receivables'
import { COUNTED_WAREHOUSES, mapVismaStock } from './stock'
import type {
  VismaCustomerDocument,
  VismaCustomerInvoice,
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

/**
 * Visma caps `customerinvoice` at this, the same as `customerdocument` — and
 * scoped to one customer it is a ceiling nothing is expected to reach.
 *
 * Measured 2026-08-18: `customer=10681&pageSize=1000` returned 31 rows, all JPK
 * Trading Kft, spanning 2024-08-07 to 2026-07-17. That is a linked customer's
 * ENTIRE invoice history in a single request. A full page therefore means there
 * is more of somebody's history than we saw, which the run reports as partial
 * rather than importing a silent fraction of their sales.
 */
export const B2B_SALES_PAGE_SIZE = 1000

export type VismaB2bSalesResult = {
  configured: boolean
  /**
   * B2B customers carrying a Visma number. Reported because zero is the
   * difference between "nothing to import" and "the import is broken" — and on
   * the day this shipped, zero imports was the expected honest answer.
   */
  linked: number
  /** Invoices Visma returned, before any of them were filtered out. */
  read: number
  /** Orders written. */
  imported: number
  skipped: { reason: string; count: number }[]
  /** True when we did not reach the end. What we did read is still stored. */
  partial: boolean
  error: string | null
}

const noSales = (over: Partial<VismaB2bSalesResult> = {}): VismaB2bSalesResult => ({
  configured: true,
  linked: 0,
  read: 0,
  imported: 0,
  skipped: [],
  partial: false,
  error: null,
  ...over,
})

/**
 * Write one imported invoice as an order with its lines.
 *
 * Deliberately the shape `storeOrder` uses for a WooCommerce order: the order
 * and its lines land in ONE transaction, so a crash between them can never
 * leave an order visible with nothing inside it, and the lines are rewritten
 * rather than diffed — simpler and always correct. The metrics engine then
 * reads these rows exactly as it reads a webshop order's, with no special case.
 *
 * Reports how many lines named a product this shop does not have, so the run
 * can say so. Losing a whole invoice over one line we cannot place is worse.
 */
async function storeB2bSale(
  order: MappedB2bOrder,
  productIdBySku: Map<string, string>,
  customer: { name: string; email: string | null; vatPercent: number },
): Promise<{ stored: boolean; unknownLines: number }> {
  const placed = order.lines.map((l) => ({ line: l, productId: productIdBySku.get(l.sku) }))
  const items = placed.filter((p) => p.productId !== undefined)
  const unknownLines = placed.length - items.length

  // Nothing on this invoice is a product this shop sells. An order with no
  // lines would sit in every total as a sale worth zero.
  if (items.length === 0) return { stored: false, unknownLines }

  const totals = orderTotals(
    // No discount is passed: Visma prices each line net, so `discountAmount` is
    // already inside the unit price we read, and subtracting it again would
    // take it off twice.
    items.map((p) => ({
      quantity: p.line.quantity,
      unitPrice: p.line.unitPrice,
      discountValue: 0,
      discountKind: 'PERCENT' as const,
    })),
    // Nothing is charged for shipping here. What shipping COST us is a separate
    // question, and the shop's standing fulfillment rate already answers it.
    0,
    customer.vatPercent,
  )

  const data = {
    shopId: order.shopId,
    externalId: order.externalId,
    // Visma's own invoice number, so a figure on screen traces straight back to
    // the document it came from. It cannot disturb the B-0001 sequence
    // hand-entered orders use: parseB2bNumber scores anything else 0.
    number: order.referenceNumber,
    placedAt: order.placedAt,
    currency: order.currency,
    grossSales: totals.grossSales,
    discountTotal: totals.discountTotal,
    netSales: totals.netSales,
    shippingCharged: totals.shippingCharged,
    taxTotal: totals.taxTotal,
    total: totals.total,
    // Not null, for the reason a hand-entered B2B order sets them: it keeps
    // this order out of backfillCustomers()' queue, which would otherwise ask
    // WooCommerce over and over about an order it has never heard of.
    customerName: customer.name,
    customerEmail: customer.email ?? '',
    b2bCustomerId: order.b2bCustomerId,
  }

  await db.$transaction(async (tx) => {
    const row = await tx.order.upsert({
      where: { shopId_externalId: { shopId: order.shopId, externalId: order.externalId } },
      // `status` is set on create and never updated, the same way the
      // purchase-order import leaves `notes` alone: someone may have voided
      // this order here, and Visma has no opinion about that.
      create: { ...data, status: 'completed' },
      update: data,
    })
    await tx.orderItem.deleteMany({ where: { orderId: row.id } })
    await tx.orderItem.createMany({
      data: items.map((p) => ({
        orderId: row.id,
        productId: p.productId!,
        sku: p.line.sku,
        name: p.line.name,
        quantity: p.line.quantity,
        unitPrice: p.line.unitPrice,
        lineNetTotal: p.line.quantity * p.line.unitPrice,
      })),
    })
  })

  return { stored: true, unknownLines }
}

/**
 * Pull Visma's customer invoices in as B2B orders.
 *
 * **This is the import that can double every revenue figure in the product, so
 * read the filter before changing anything here.** Visma raises an invoice for
 * every WEBSHOP order too, against house accounts named "Panetti Norge -
 * Webkunde" and seven more — 994 of the first 1000 open documents on
 * 2026-08-18 — and those same orders already arrive from WooCommerce. So the
 * filter is an ALLOWLIST: an invoice becomes a sale only when its Visma
 * customer number matches a `B2bCustomer.vismaCustomerNumber` somebody
 * deliberately typed. Everything else is ignored, counted, and never stored.
 *
 * With nothing linked it makes no HTTP call at all. That is not an
 * optimisation: the rate limit is a rolling window shared with the receivables
 * import, so a request that could not possibly match anything would cost that
 * import its own page in the same run.
 *
 * Never throws, like the other three imports — the scheduled sync calls them
 * all and one ERP hiccup must not cost the store pull.
 *
 * Idempotent, which is why this upserts rather than snapshotting: an order is
 * keyed on `visma-<referenceNumber>` within its shop, so a re-run updates it.
 * That is also why a PARTIAL read is safe to write here where it is not for
 * receivables — the pages we did reach are simply correct, and the rest arrive
 * next run rather than deleting anything.
 *
 * **It reads one customer at a time, and the parameter is `customer`.** Measured
 * 2026-08-18:
 *
 *   customerinvoice?customer=10681       -> 5 rows, all JPK Trading Kft. WORKS.
 *   customerinvoice?customerNumber=10681 -> 5 rows, all Kitch'n. IGNORED.
 *
 * `customerNumber` is the more natural-looking name and it is a TRAP: it comes
 * back HTTP 200 carrying somebody else's invoices, so an import built on it
 * would file real orders under the wrong customer with no error anywhere. An
 * unknown parameter on this endpoint is silently dropped, which is why a filter
 * here is only ever proven by the rows it returns, never by the status code. Do
 * not "tidy" this back.
 *
 * Scoping the request to the customer is also what makes the history COMPLETE.
 * This once read the whole ledger through a `lastModifiedDateTime` window
 * floored at a fixed start date, which quietly meant anything older than that
 * floor could never be imported at all — and JPK's invoices begin 2024-08-07,
 * so roughly eighteen months of real B2B sales would have been permanently
 * invisible in the feature built to show them. Per customer there is no floor
 * and no watermark: `customer=10681&pageSize=1000` returned that customer's
 * entire history, 31 rows, in one request. A newly linked customer's whole past
 * therefore arrives on the very next run.
 *
 * The cost of a run now follows how many customers are linked — three or four
 * today, one bounded request each — instead of how big the ledger is.
 */
export async function importVismaB2bSales(
  opts: { deadline?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<VismaB2bSalesResult> {
  const result = await readVismaB2bSales(opts)

  // Recorded so the B2B page can show what the last run did. A deployment
  // without Visma has nothing to report and writes nothing, so an unconfigured
  // workspace does not grow a row saying it imported nothing.
  if (result.configured) await recordB2bImportRun(result)

  return result
}

/**
 * Keep the last run where a person will see it.
 *
 * Best-effort and deliberately swallowing its own failure: this is a REPORT of
 * the import, and a report that could fail the thing it reports on would be
 * worse than no report. The orders are already written by this point.
 */
async function recordB2bImportRun(result: VismaB2bSalesResult): Promise<void> {
  const row = {
    ranAt: new Date(),
    linked: result.linked,
    read: result.read,
    imported: result.imported,
    partial: result.partial,
    error: result.error,
  }
  try {
    await db.b2bImportRun.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...row },
      update: row,
    })
  } catch {
    // The import stands whatever this did. The page shows the previous run.
  }
}

async function readVismaB2bSales(
  opts: { deadline?: number; sleep?: (ms: number) => Promise<unknown> },
): Promise<VismaB2bSalesResult> {
  // Injected by tests so two seconds of pacing a customer does not make a suite
  // take half a minute. Production always uses the real one.
  const sleep = opts.sleep ?? pause

  const creds = vismaCredentials()
  if (!creds) return noSales({ configured: false })

  try {
    const customers = await db.b2bCustomer.findMany({
      where: { vismaCustomerNumber: { not: null } },
      // Ordered, because the read below is one request per customer and a
      // deadline or a 429 cuts it off partway: a stable order makes a truncated
      // run reproducible instead of leaving which customers arrived to chance.
      // Worth revisiting only if refusals ever become routine here — a fixed
      // order would then always starve the same names.
      orderBy: { vismaCustomerNumber: 'asc' },
      select: {
        id: true, shopId: true, currency: true, name: true, email: true,
        vatPercent: true, vismaCustomerNumber: true,
      },
    })

    const linkedByNumber: LinkedCustomers = new Map(
      customers
        .map((c) => ({ ...c, number: c.vismaCustomerNumber!.trim() }))
        // A blank key would open the guard the whole product's revenue rests
        // on: a whitespace-only number trims to '', and `str()` in the mapper
        // reads a missing customer number as '' too, so EVERY such invoice
        // would match it. Both write paths clean the field before it is stored,
        // and this does not depend on that being true two files away.
        .filter((c) => c.number !== '')
        .map((c) => [
          c.number,
          { b2bCustomerId: c.id, shopId: c.shopId, currency: c.currency },
        ]),
    )
    // Nothing could match, so nothing here is worth a rate-limited request.
    if (linkedByNumber.size === 0) return noSales()

    const invoices: VismaCustomerInvoice[] = []
    let read = 0
    let partial = false
    for (const number of linkedByNumber.keys()) {
      // Paced before EVERY request, the first one included. The rate limit is a
      // rolling window shared with the other three Visma imports and a burst
      // exhausts it for minutes, so arriving on the heels of whatever the run
      // just did is how this import comes to lose the same customers every
      // time — and it is the one whose loss is a wrong revenue picture rather
      // than a stale operational one.
      //
      // The wait counts toward the deadline: starting one we already know will
      // end past it just burns the run's last seconds.
      if (opts.deadline !== undefined && Date.now() + PAGE_PAUSE_MS > opts.deadline) {
        partial = true
        break
      }
      await sleep(PAGE_PAUSE_MS)

      let batch: VismaCustomerInvoice[]
      try {
        batch = await vismaGet<VismaCustomerInvoice[]>(
          creds,
          // `customer`, NOT `customerNumber`. Measured 2026-08-18:
          // customer=10681 returned 5 rows all JPK Trading Kft, while
          // customerNumber=10681 returned 5 rows of Kitch'n — HTTP 200, someone
          // else's invoices, no error. Encoded because the field this comes
          // from is free text, not a validated number.
          `controller/api/v1/customerinvoice?customer=${encodeURIComponent(number)}` +
            `&pageSize=${B2B_SALES_PAGE_SIZE}`,
          // The deadline reaches the REQUEST, not just this loop. Without it the
          // fixed 60-second ceiling makes the deadline a claim rather than a
          // bound: a request starting just inside it finishes well past the
          // platform's 300s ceiling and takes the stages after this one down.
          { deadline: opts.deadline },
        )
      } catch (e) {
        // 429 only, exactly as the receivables import treats it: the limit is a
        // rolling window that a burst exhausts for minutes, so a refusal
        // partway through is expected rather than exceptional. It stops the
        // whole loop rather than skipping one customer — the window is spent,
        // not that customer's luck. Anything else is a real failure: a 500 or a
        // bad token is not something waiting fifteen minutes fixes, and
        // swallowing it would hide a broken integration behind an import that
        // quietly stopped importing.
        if (e instanceof VismaError && e.status === 429) {
          partial = true
          break
        }
        throw e
      }

      const rows = Array.isArray(batch) ? batch : []
      read += rows.length
      invoices.push(...rows)

      // A full page is a ceiling, not an end. One customer's entire history
      // measured 31 invoices, so this should never fire — and if it does, part
      // of somebody's sales is missing and the run has to say so rather than
      // report a confident number built on a fraction of their invoices.
      if (rows.length >= B2B_SALES_PAGE_SIZE) partial = true
    }

    const mapped = mapVismaB2bSales(invoices, linkedByNumber)
    const byId = new Map(customers.map((c) => [c.id, c]))

    // One shop's catalogue read once, not once per line, and keyed on
    // normaliseSku for the reason the purchase-order import keys on it: two
    // spellings of one SKU would fail to join for no visible reason.
    const catalogues = new Map<string, Map<string, string>>()
    const catalogueFor = async (shopId: string) => {
      const held = catalogues.get(shopId)
      if (held) return held
      const products = await db.product.findMany({
        where: { shopId },
        select: { id: true, sku: true },
        orderBy: { id: 'asc' },
      })
      const bySku = new Map<string, string>()
      // First wins, so a shop holding two listings of one SKU always resolves
      // to the same product rather than to whichever came back first today.
      for (const p of products) {
        const sku = normaliseSku(p.sku)
        if (!bySku.has(sku)) bySku.set(sku, p.id)
      }
      catalogues.set(shopId, bySku)
      return bySku
    }

    let imported = 0
    let unknown = 0
    for (const order of mapped.orders) {
      const customer = byId.get(order.b2bCustomerId)
      // mapVismaB2bSales only ever names a customer we read a moment ago.
      if (!customer) continue

      const result = await storeB2bSale(order, await catalogueFor(order.shopId), customer)
      unknown += result.unknownLines
      if (result.stored) imported += 1
    }

    return noSales({
      linked: linkedByNumber.size,
      read,
      imported,
      // 'not our product' is the phrase the purchase-order import already uses
      // for a line whose SKU we do not sell. One vocabulary, one meaning.
      skipped: unknown > 0
        ? [...mapped.skipped, { reason: 'not our product', count: unknown }]
        : mapped.skipped,
      partial,
    })
  } catch (e) {
    // Reported, not thrown. The sync route shows this and the next run retries.
    return noSales({ error: e instanceof Error ? e.message : 'Visma B2B sales import failed' })
  }
}
