import { orderTotals } from '../b2b/pricing'
import { db } from '../db'
import { normaliseSku } from '../inventory/sku'
import {
  b2bSalesModifiedSince,
  mapVismaB2bSales,
  VISMA_EXTERNAL_ID_PREFIX,
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

/** Visma caps `customerinvoice` at this, the same as `customerdocument`. */
export const B2B_SALES_PAGE_SIZE = 1000

/**
 * A backstop on the loop, and NOT the thing that keeps this run small — the
 * `lastModifiedDateTime` window is. Measured 2026-08-18: `customerinvoice` runs
 * from reference 100000 dated 2022-09-09 to roughly 130350 today, about 30 000
 * invoices ordered OLDEST-FIRST. Ten unfiltered pages of 1 000 would read
 * references 100000-110000 — all of 2022 and 2023 — and stop, so the ceiling
 * alone would have meant `imported: 0` every run, forever.
 *
 * With the window applied, an ordinary run is one page and a first run from
 * B2B_SALES_FIRST_RUN_FROM is about five. So reaching ten is not proof anything
 * is broken; it means more was modified in the window than a bounded run can
 * carry, and the rest is left for the next one.
 */
const MAX_B2B_SALES_PAGES = 10

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
 * **The window is what makes it work at all.** `customerinvoice` is ordered
 * oldest-first over roughly 30 000 invoices, so it is read through
 * `lastModifiedDateTimeCondition=%3E&lastModifiedDateTime=<date>`. That exact
 * pair was measured working on 2026-08-18: with it, page one came back as
 * reference 129612 dated 2026-08-03; the date sent WITHOUT the condition
 * parameter was silently ignored and page one came back as reference 100000
 * dated 2022-09-09. An unknown parameter here returns HTTP 200 and does
 * nothing, so a filter is only ever proven by the rows it returns.
 *
 * A per-customer filter would be better still — we care about three or four
 * customers, so the result would not depend on the ledger's size at all — but
 * `customerNumber=` is UNVERIFIED. This checkout holds no Visma credentials, so
 * it could not be tried. Anyone who can reach the API should test it and check
 * the customer names on every returned row, not the status code.
 */
export async function importVismaB2bSales(
  opts: { deadline?: number } = {},
): Promise<VismaB2bSalesResult> {
  const creds = vismaCredentials()
  if (!creds) return noSales({ configured: false })

  try {
    const customers = await db.b2bCustomer.findMany({
      where: { vismaCustomerNumber: { not: null } },
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

    // The newest invoice we already hold dates the window; see
    // b2bSalesModifiedSince for why it reaches back a margin before it and why
    // it can never reach back past the fixed first-run date.
    const newest = await db.order.findFirst({
      where: { externalId: { startsWith: VISMA_EXTERNAL_ID_PREFIX } },
      orderBy: { placedAt: 'desc' },
      select: { placedAt: true },
    })
    const modifiedSince = b2bSalesModifiedSince(newest?.placedAt ?? null)

    const invoices: VismaCustomerInvoice[] = []
    let read = 0
    let partial = false

    for (let page = 1; page <= MAX_B2B_SALES_PAGES; page++) {
      // Checked before each page rather than assumed, exactly as the parcel
      // poll checks its own: this stage begins after the shops may already have
      // spent 240 of the route's 300 seconds, and ten pages at a 60-second
      // timeout apiece would run long past the platform ceiling — killing the
      // parcel poll and the delivery alert that come after it. A page already
      // in flight is not interrupted, which is the same contract syncAllShops
      // and syncShipments have.
      if (opts.deadline !== undefined && Date.now() > opts.deadline) {
        partial = true
        break
      }

      let batch: VismaCustomerInvoice[]
      try {
        batch = await vismaGet<VismaCustomerInvoice[]>(
          creds,
          `controller/api/v1/customerinvoice` +
            // %3E is '>'. The date WITHOUT this condition parameter is accepted
            // and silently ignored — measured 2026-08-18, it still returned
            // reference 100000 from 2022 — so the pair travels together or the
            // read is unbounded again.
            `?lastModifiedDateTimeCondition=%3E&lastModifiedDateTime=${modifiedSince}` +
            `&pageSize=${B2B_SALES_PAGE_SIZE}&pageNumber=${page}`,
        )
      } catch (e) {
        // 429 only, exactly as the receivables import treats it: the limit is a
        // rolling window that a burst exhausts for minutes, so a refusal
        // partway through is expected rather than exceptional. Anything else is
        // a real failure — a 500 or a bad token is not something waiting
        // fifteen minutes fixes, and swallowing it would hide a broken
        // integration behind an import that quietly stopped importing.
        if (e instanceof VismaError && e.status === 429) {
          partial = true
          break
        }
        throw e
      }

      const rows = Array.isArray(batch) ? batch : []
      read += rows.length
      invoices.push(...rows)

      // A short page is the end of the collection. A full one on the last
      // allowed page is not an end, it is a ceiling, and that is a partial read.
      if (rows.length < B2B_SALES_PAGE_SIZE) break
      if (page === MAX_B2B_SALES_PAGES) partial = true
      else await pause(PAGE_PAUSE_MS)
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
