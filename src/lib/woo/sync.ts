import { db } from '../db'
import { VOIDED_STATUSES } from '../metrics/types'
import { decryptSecret } from '../secrets'
import {
  fetchCatalog,
  fetchOrderStatuses,
  fetchOrders,
  fetchOrdersByIds,
  type CatalogEntry,
  type WooCredentials,
} from './client'
import { mapOrder, type WooOrder } from './map'
import { ensureWebhooks } from './webhooks'

export type SyncResult = {
  shopId: string
  shopName: string
  ok: boolean
  ordersSynced: number
  /** This pull landed, but more is behind it: history, a full page cap, or the deadline. */
  more?: boolean
  /**
   * Orders the store had and we did not. Reported rather than fixed in
   * silence: a hole is invisible by nature - the books look complete because
   * the order was never there to be noticed - so the only way anyone learns it
   * happened is if the sync says so.
   */
  added?: number
  /**
   * Orders we held whose status or charged total had drifted. Kept apart from
   * `added`: one can only raise a total, the other can lower it.
   */
  updated?: number
  /** The repair pass itself failed. The sync still succeeded; the books may not be whole. */
  repairError?: string
  error?: string
}

/**
 * One press pulls up to this many pages (x100 orders) of history per shop.
 * Sized so one chunk (fetching from a real WordPress at ~1s a page, then
 * storing) always finishes well inside one serverless invocation.
 */
const BACKFILL_PAGES = 25

const DAY = 24 * 60 * 60 * 1000

/**
 * Incremental pulls reach back this far behind the watermark. Woo is only told
 * whole seconds, and the store's clock need not agree with ours - a fetch that
 * starts exactly at the watermark can miss an order changed a breath earlier.
 * Re-fetching five minutes twice is free: every store costs one page most
 * pulls, and the upserts are idempotent.
 */
const OVERLAP = 5 * 60 * 1000

/**
 * A store that hands back orders in some order other than the one we asked for.
 * We cannot advance the watermark past rows we cannot prove we have seen, so
 * this store needs a human rather than another identical retry.
 */
const UNSORTED_STORE =
  'This store did not return orders sorted by modified date, so the sync cannot safely resume. Check the store for a plugin that overrides REST API ordering.'

/**
 * More orders share one moment than a single run can carry, so the resume point
 * never clears the overlap we reach back through and the window would be
 * refetched forever. Nothing is skipped - the watermark refuses to move
 * backwards - but only a human can clear it.
 */
const STALLED_STORE =
  'This store changed more orders at once than one sync can work through, so the sync cannot move past them. Check the store for a bulk update, then sync again.'

/**
 * A resume point we cannot read is not a resume point. Left unflagged this is
 * the silent freeze the branch exists to remove: no advance, no error, and a
 * page that says "Catching up" forever.
 */
const UNREADABLE_STAMP =
  'This store sent a last-modified date the sync could not read, so it cannot tell where to resume. Check the store for a plugin altering order dates.'

/** How many customer-less legacy orders one sync fills in (5 id-batches). */
const CUSTOMER_BACKFILL_BATCH = 500

/**
 * How far back a completed sync re-reads the store, and how many pages that is
 * allowed to cost.
 *
 * An incremental pull only ever asks for orders MODIFIED since the watermark,
 * and the watermark only ever moves forward. So an order missed ONCE is missed
 * FOREVER: it is never edited again, so it is never offered again. A delivery
 * lost while a deploy rolled, a run killed mid-store, a store clock that drifted
 * past OVERLAP - any of them leaves a hole in the middle of a day with the
 * orders on either side present, and every later sync reports success.
 *
 * Re-reading a few recent days is what closes it. Bounded on both sides, and it
 * writes only what actually differs, so a store whose recent past already
 * matches costs one request and no writes at all.
 */
const RECONCILE_DAYS = 3

/**
 * A store the sync could not reach for a while needs the whole silence
 * re-read, not the last three days of it: the 29 July outage ran seven days,
 * and every hole it left sits outside a three-day window forever. The window
 * therefore stretches to cover the gap since the last completed sync, plus a
 * day either side for clock drift.
 *
 * Capped, because "the shop has never synced" and "the shop synced last year"
 * both compute an enormous window, and a repair pass that tries to re-read all
 * of history is the same runaway the backfill chunking exists to prevent.
 */
const RECONCILE_MAX_DAYS = 45

/** ~100 orders a page. Scaled to the window so a wider sweep is not silently cut short. */
const RECONCILE_PAGES_PER_DAY = 1
const RECONCILE_MIN_PAGES = 3

/** couponCode (UPPERCASE) -> who owns it, for one store. */
export type CodeBook = Map<string, { ambassadorId: string }>

export async function codeBookFor(shopId: string): Promise<CodeBook> {
  // This store's codes only. A code belongs to one store, and the same text
  // can mean a different ambassador on another store, so an order is only
  // ever matched against its own store's codes.
  const codes = await db.ambassadorCode.findMany({ where: { shopId } })
  return new Map(codes.map((c) => [c.code.toUpperCase(), { ambassadorId: c.ambassadorId }]))
}

/**
 * Store one WooCommerce order: products discovered, ambassador resolved and
 * frozen, order and its lines written together. The one write path - the
 * scheduled sync and the webhook receiver both come through here, so an order
 * looks the same however it arrived.
 */
export async function storeOrder(shopId: string, raw: WooOrder, byCode: CodeBook): Promise<void> {
  const o = mapOrder(raw)

  let ambassadorId: string | null = null
  if (o.couponCode) {
    const match = byCode.get(o.couponCode)
    if (match) ambassadorId = match.ambassadorId
  }

  // Make sure every product on the order exists.
  const productIds = new Map<string, string>()
  for (const item of o.items) {
    const product = await db.product.upsert({
      where: { shopId_externalId: { shopId, externalId: item.externalProductId } },
      create: {
        shopId,
        externalId: item.externalProductId,
        sku: item.sku,
        name: item.name,
        imageUrl: item.imageUrl,
        lastPrice: item.unitPrice,
      },
      update: {
        name: item.name,
        sku: item.sku,
        lastPrice: item.unitPrice,
        // Keep the photo we already have if this order didn't carry one.
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
      },
    })
    productIds.set(item.externalProductId, product.id)
  }

  // Was this order already voided in our own records? The stamp marks a
  // TRANSITION, so an order that arrives already refunded keeps a null date -
  // we do not know when it happened, and the engine leaves such an order out
  // entirely rather than reversing it on a guessed day.
  const held = await db.order.findUnique({
    where: { shopId_externalId: { shopId, externalId: o.externalId } },
    select: { status: true, voidedAt: true },
  })
  const wasVoided = held ? VOIDED_STATUSES.includes(held.status.toLowerCase() as never) : false
  const isVoided = VOIDED_STATUSES.includes(o.status.toLowerCase() as never)

  const voidedAt = isVoided
    // Newly voided by a store we were already watching: now is the moment.
    // Already voided: keep whatever stamp we had, so a re-sync cannot move it.
    ? (wasVoided ? held!.voidedAt : held ? new Date() : null)
    // Back to life. The reversal must disappear with the status.
    : null

  const data = {
    shopId,
    externalId: o.externalId,
    number: o.number,
    placedAt: o.placedAt,
    status: o.status,
    voidedAt,
    currency: o.currency,
    grossSales: o.grossSales,
    discountTotal: o.discountTotal,
    netSales: o.netSales,
    shippingCharged: o.shippingCharged,
    taxTotal: o.taxTotal,
    total: o.total,
    couponCode: o.couponCode,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    customerPhone: o.customerPhone,
    shippingCountry: o.shippingCountry,
    ambassadorId,
  }

  // The order and its lines land together or not at all - a crash between the
  // two must never leave an order visible with nothing inside it. Lines are
  // rewritten rather than diffed: simpler and always correct.
  await db.$transaction(async (tx) => {
    const order = await tx.order.upsert({
      where: { shopId_externalId: { shopId, externalId: o.externalId } },
      create: data,
      update: data,
    })
    await tx.orderItem.deleteMany({ where: { orderId: order.id } })
    await tx.orderItem.createMany({
      data: o.items.map((item) => ({
        orderId: order.id,
        productId: productIds.get(item.externalProductId)!,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineNetTotal: item.lineNetTotal,
      })),
    })
  })
}

/**
 * How wide the repair window has to be for this shop, in days.
 *
 * Normally the last few days. But a store the sync could not reach for a week
 * has a week of possible holes, all of them outside a three-day window - and
 * outside it FOREVER, because the incremental pull will never offer those
 * orders again. So the window stretches to cover the silence: the gap since the
 * last completed sync, plus a day either side for clock drift.
 */
export function reconcileWindow(lastSyncAt: Date | null, now: Date): number {
  if (!lastSyncAt) return RECONCILE_DAYS // a first sync just read all of history
  const gap = (now.getTime() - lastSyncAt.getTime()) / DAY
  return Math.min(RECONCILE_MAX_DAYS, Math.max(RECONCILE_DAYS, Math.ceil(gap) + 1))
}

export type Reconciliation = {
  /**
   * Orders the store had and we did not hold at all. These are the ones that
   * move a figure: revenue we were never counting is now counted.
   */
  added: number
  /**
   * Orders we held whose status or charged total had drifted from the store's.
   * Reported apart from `added` because the two mean opposite things to anyone
   * reading a number: a recovered order can only raise a total, while a
   * correction can just as easily lower it - an order that quietly became
   * cancelled takes its revenue back out. Rolling them together produced
   * "11 orders were missing", which was not true and promised a rise that
   * might not come.
   */
  updated: number
  /**
   * False when the store had more in the window than this pass could read, so
   * some of it was NOT checked. A repair that quietly stops short is worse than
   * no repair: it reads as proof the books agree when nothing looked.
   */
  complete: boolean
}

/**
 * Make our copy of a recent window agree with the store's.
 *
 * The incremental window cannot do this: it asks what CHANGED, and a missed
 * order did not change. This asks what EXISTS, and repairs anything absent or
 * drifted. It is the only path by which a hole heals.
 *
 * Only orders that are missing, or whose status or charged total no longer
 * match, are written - those two decide whether an order counts and for how
 * much. A healthy store therefore costs one request and no writes.
 *
 * Never deletes. An order the store does not return is left exactly as it is:
 * a truncated page or a store that hides old orders must not be able to erase
 * real history.
 */
export async function reconcileRecent(
  shopId: string,
  creds: WooCredentials,
  opts: { days?: number; deadline?: number; statuses?: string[] } = {},
): Promise<Reconciliation> {
  const days = opts.days ?? RECONCILE_DAYS
  const since = new Date(Date.now() - days * DAY)

  const { orders, hasMore } = await fetchOrders(creds, {
    createdAfter: since,
    // Named outright. A repair pass that inherits WooCommerce's default cannot
    // see an order sitting in a status the store invented - which is exactly
    // the order most likely to be missing, since only a webhook could have
    // brought it in and a webhook is the thing that gets lost.
    statuses: opts.statuses,
    // Scaled to the window: a fixed cap would silently check only the first few
    // hundred orders of a wide sweep and report success for the rest.
    maxPages: Math.max(RECONCILE_MIN_PAGES, Math.ceil(days * RECONCILE_PAGES_PER_DAY)),
    deadline: opts.deadline,
  })
  if (orders.length === 0) return { added: 0, updated: 0, complete: !hasMore }

  const held = await db.order.findMany({
    where: { shopId, placedAt: { gte: since } },
    select: { externalId: true, status: true, total: true },
  })
  const heldBy = new Map(held.map((o) => [o.externalId, o]))

  const byCode = await codeBookFor(shopId)
  let added = 0
  let updated = 0
  for (const raw of orders) {
    const mine = heldBy.get(String(raw.id))
    const theirs = mapOrder(raw)
    if (!mine) {
      await storeOrder(shopId, raw, byCode)
      added++
    } else if (mine.status !== theirs.status || mine.total !== theirs.total) {
      await storeOrder(shopId, raw, byCode)
      updated++
    }
  }
  return { added, updated, complete: !hasMore }
}

/**
 * Fill in the customer on orders synced before customers were stored. Targets
 * exactly the orders where customerName is still null (newest first - the ones
 * being looked at), asks Woo for those ids only, and touches NOTHING but the
 * three customer fields. An order Woo no longer has, or one with no billing
 * details, is marked '' - checked, nothing there - so the queue only ever
 * shrinks and this costs zero once history is filled.
 */
export async function backfillCustomers(shopId: string, creds: WooCredentials): Promise<number> {
  const missing = await db.order.findMany({
    // Widened when the phone column arrived: every order synced before it has
    // customerName set and customerPhone null. Same queue, same drain, same
    // '' when the store has none — it costs zero again once history is filled.
    where: { shopId, OR: [{ customerName: null }, { customerPhone: null }] },
    orderBy: { placedAt: 'desc' },
    take: CUSTOMER_BACKFILL_BATCH,
    select: { id: true, externalId: true, customerName: true, customerEmail: true, customerPhone: true },
  })
  if (missing.length === 0) return 0

  const fetched = new Map<string, WooOrder>()
  for (const raw of await fetchOrdersByIds(creds, missing.map((m) => m.externalId))) {
    fetched.set(String(raw.id), raw)
  }

  for (const m of missing) {
    const raw = fetched.get(m.externalId)
    const o = raw ? mapOrder(raw) : null
    await db.order.update({
      where: { id: m.id },
      data: {
        // What Woo says wins; what we already hold survives a store that no
        // longer has the order (a Visma or B2B row queued only for its null
        // phone must not have its real name wiped to ''); only then comes
        // '' — checked, nothing there.
        customerName: o?.customerName ?? m.customerName ?? '',
        customerEmail: o?.customerEmail ?? m.customerEmail ?? '',
        customerPhone: o?.customerPhone ?? m.customerPhone ?? '',
      },
    })
  }
  return missing.length
}

/**
 * Fill in the destination country on orders synced before it was stored. Same
 * shape as backfillCustomers: targets exactly the orders where the field is
 * still null, newest first, asks Woo for those ids only, and writes nothing
 * else. An order Woo no longer has is marked '' - checked, nothing there - so
 * the queue only ever shrinks and this costs zero once history is filled.
 */
export async function backfillDelivery(shopId: string, creds: WooCredentials): Promise<number> {
  const missing = await db.order.findMany({
    where: { shopId, shippingCountry: null },
    orderBy: { placedAt: 'desc' },
    take: CUSTOMER_BACKFILL_BATCH,
    select: { id: true, externalId: true },
  })
  if (missing.length === 0) return 0

  const fetched = new Map<string, WooOrder>()
  for (const raw of await fetchOrdersByIds(creds, missing.map((m) => m.externalId))) {
    fetched.set(String(raw.id), raw)
  }

  for (const m of missing) {
    const raw = fetched.get(m.externalId)
    await db.order.update({
      where: { id: m.id },
      data: { shippingCountry: raw ? mapOrder(raw).shippingCountry : '' },
    })
  }
  return missing.length
}

/**
 * Record one attempt on a store.
 *
 * `lastRunAt` moves on EVERY attempt, including failures. This is what keeps
 * the rotation in `syncAllShops` fair: a permanently broken store whose
 * `lastRunAt` never moved would sit at the front of the queue and burn a slot
 * on every single run. Moving it costs a broken store one slot, then it goes to
 * the back.
 *
 * `lastSyncAt` moves only when a caller passes one, so a window that failed is
 * retried unchanged rather than skipped.
 *
 * Never throws. If the database is what broke, the caller's own error is the
 * one worth reporting - not a second, more confusing one from the bookkeeping.
 */
async function recordRun(
  shopId: string,
  outcome: { lastSyncAt?: Date; error?: string | null },
): Promise<void> {
  try {
    await db.shop.update({
      where: { id: shopId },
      data: {
        lastRunAt: new Date(),
        lastError: outcome.error ?? null,
        ...(outcome.lastSyncAt ? { lastSyncAt: outcome.lastSyncAt } : {}),
      },
    })
  } catch {
    // Bookkeeping is never worth failing a sync over.
  }
}

/**
 * Write a shop's catalogue readings onto its products.
 *
 * Exported so it can be tested without running a whole sync. Only products the
 * catalogue actually mentioned are touched - a truncated page or a product the
 * store no longer lists must never blank a figure we already hold.
 */
export async function storeCatalog(
  shopId: string,
  catalog: Map<string, CatalogEntry>,
): Promise<void> {
  if (catalog.size === 0) return

  const known = await db.product.findMany({
    where: { shopId },
    select: { id: true, externalId: true, catalogPrice: true, stockQuantity: true },
  })

  const now = new Date()
  for (const p of known) {
    const entry = catalog.get(p.externalId)
    if (entry === undefined) continue // not mentioned: leave it exactly as it is

    // A fractional quantity cannot go into an Int column, and the caller swallows
    // the throw - one bad value would silently freeze this shop's stock for good.
    // Unknown is honest and the page says so out loud.
    const stock = entry.stock !== null && Number.isInteger(entry.stock) ? entry.stock : null

    const data: { catalogPrice?: number; stockQuantity: number | null; stockUpdatedAt: Date } = {
      // Always written, even when unchanged: the stamp is how the page says when
      // we last looked, and "unchanged" is itself a reading.
      stockQuantity: stock,
      stockUpdatedAt: now,
    }
    if (entry.price !== null && entry.price !== p.catalogPrice) data.catalogPrice = entry.price

    await db.product.update({ where: { id: p.id }, data })
  }
}

/**
 * Pull a shop's orders and store them.
 *
 * Two phases, decided by `lastSyncAt`:
 *
 * FIRST SYNC (lastSyncAt unset) - history arrives oldest-first in chunks of
 * BACKFILL_PAGES pages. Each press stores its chunk and resumes one second
 * behind the newest stored order, so a store of any size gets in without ever
 * exceeding one serverless invocation. Only when the last chunk lands does
 * lastSyncAt get set - a day in the past, so anything edited while the
 * backfill ran is caught by the first incremental sync.
 *
 * INCREMENTAL (lastSyncAt set) - only orders changed since five minutes before
 * the last completed sync (see OVERLAP). A pull the page cap or the deadline
 * cut short stores what it fetched, then - only if the store proved it
 * honoured `orderby=modified` AND the resume point actually lands ahead of
 * where we started - moves the watermark there, so a backlog drains a little
 * more each run instead of being handed back the same, wider window forever.
 * A cut-short pull that fails either check stops without advancing and says
 * why: an unsorted result cannot be trusted, and a resume point that never
 * clears OVERLAP (more orders sharing one moment than a run can carry) would
 * refetch the same page forever. On any other failure lastSyncAt is left
 * untouched so the next run retries the same window.
 *
 * - The watermark records when the FETCH began, not when storing finished - an
 *   order changed while the sync was running must fall inside the next window.
 * - Products are discovered from the orders themselves - anything ever sold appears
 *   in Product Costs automatically, with no cost until someone enters one.
 * - Ambassador attribution is resolved HERE and frozen on the order, so renaming or
 *   reassigning a code later can never rewrite past commissions.
 * - After a completed sync, best-effort and never fatally: catalog prices
 *   refresh, legacy orders get their customer filled in, and the store's
 *   webhooks are (re)registered so changes stream in live between syncs.
 */
export async function syncShop(
  shopId: string,
  /**
   * `backfillPages` bounds a first-sync chunk, `maxPages` an incremental one -
   * the same seam for the other half of the function, and the only way a test
   * can produce a partial incremental pull without fetching 5,000 orders.
   */
  opts: { backfillPages?: number; maxPages?: number; deadline?: number } = {},
): Promise<SyncResult> {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } })
  const base = { shopId: shop.id, shopName: shop.name }

  // Claim the attempt BEFORE any work. Every exit below records it too, but an
  // exit is only reached if we get there - an invocation killed mid-store, by
  // the platform ceiling or a slow catalog fetch or a long storing loop, would
  // otherwise leave lastRunAt untouched. This store would then stay at the head
  // of `lastRunAt ASC NULLS FIRST` forever, re-do the same work every run, and
  // starve every store behind it. That is the outage this whole branch exists
  // to fix, so the invariant has to hold unconditionally, not just on the paths
  // that return.
  //
  // lastError is deliberately NOT touched: the previous reason stands until
  // this attempt actually has an outcome.
  await db.shop
    .update({ where: { id: shop.id }, data: { lastRunAt: new Date() } })
    .catch(() => {
      // Bookkeeping is never worth failing a sync over - same rule as recordRun.
    })

  if (!shop.wooUrl || !shop.wooKey || !shop.wooSecret) {
    const error = 'No WooCommerce credentials for this shop'
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }

  let key: string
  let secret: string
  try {
    key = decryptSecret(shop.wooKey)
    secret = decryptSecret(shop.wooSecret)
  } catch {
    // Only possible if AUTH_SECRET changed after the shop was connected.
    const error = "Saved keys can't be read. Reconnect this shop."
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
  const creds: WooCredentials = { url: shop.wooUrl, key, secret }

  try {
    const firstSync = !shop.lastSyncAt

    // Mid-backfill, resume one second behind the newest stored order - the
    // boundary order is re-fetched, which the upserts make harmless.
    let createdAfter: Date | undefined
    if (firstSync) {
      const newest = await db.order.findFirst({
        where: { shopId: shop.id },
        orderBy: { placedAt: 'desc' },
        select: { placedAt: true },
      })
      if (newest) createdAfter = new Date(newest.placedAt.getTime() - 1000)
    }

    // Stamped before the first word to the store, not after: the watermark's
    // whole job is that nothing changed while we worked can fall between two
    // windows, and the status lookup below is already time spent on this store.
    const fetchStartedAt = new Date()

    // Which statuses this store actually uses, its own inventions included.
    // Every pull below names them, because WooCommerce's default quietly omits
    // custom statuses - a store with its own "shipping" step would otherwise
    // hand back windows with those orders missing and no sign anything was.
    const statuses = await fetchOrderStatuses(creds, { deadline: opts.deadline })
    const { orders, hasMore, resumeFrom, sortedByModified } = await fetchOrders(
      creds,
      firstSync
        ? {
            createdAfter,
            statuses,
            maxPages: opts.backfillPages ?? BACKFILL_PAGES,
            deadline: opts.deadline,
          }
        : {
            modifiedAfter: new Date(shop.lastSyncAt!.getTime() - OVERLAP),
            statuses,
            maxPages: opts.maxPages,
            deadline: opts.deadline,
          },
    )

    const byCode = await codeBookFor(shop.id)

    let synced = 0
    let added = 0
    let updated = 0
    let repairError: string | undefined
    for (const raw of orders) {
      await storeOrder(shop.id, raw, byCode)
      synced++
    }

    if (hasMore) {
      // A partial pull: the page cap or the deadline stopped us. The best-effort
      // work below belongs to a completed sync, and if the deadline is what
      // stopped us there is no time for it anyway.
      //
      // A first sync's watermark stays unset so the next run resumes the
      // backfill instead of going incremental. An incremental pull moves its
      // watermark to the last order it actually processed, when it can trust
      // that resume point - that is what makes a backlog drain instead of
      // being handed back, bigger, every run.
      //
      // Only an incremental pull has a resume point, and only a store that
      // honoured the ordering has one worth trusting.
      const unsorted = !firstSync && !sortedByModified
      const candidate =
        !firstSync && sortedByModified && resumeFrom ? new Date(resumeFrom + 'Z') : null

      // A stamp we cannot parse is not a watermark. An Invalid Date is truthy,
      // so it would reach Prisma, throw inside recordRun, and be swallowed by
      // its own catch - losing lastRunAt too, the one thing recordRun exists to
      // guarantee.
      const parsed = candidate && !Number.isNaN(candidate.getTime()) ? candidate : null

      // A resume point we cannot read is not a resume point. Left unflagged this
      // is the silent freeze the branch exists to remove: no advance, no error,
      // and a page that says "catching up" forever.
      const unreadable = candidate !== null && parsed === null

      // The watermark moves forward or not at all. If more orders share a moment
      // than one run can carry, the resume point lands inside the OVERLAP we
      // already reach back through, and writing it would pin - or rewind - the
      // window so the same page is refetched forever. That is not a skip, but it
      // is a standstill, and a standstill reported as success is worse than the
      // refusal this replaced.
      const advanced = parsed !== null && (!shop.lastSyncAt || parsed > shop.lastSyncAt)
      const stalled = parsed !== null && !advanced

      const error = unsorted ? UNSORTED_STORE : unreadable ? UNREADABLE_STAMP : stalled ? STALLED_STORE : null
      await recordRun(shop.id, {
        ...(advanced ? { lastSyncAt: parsed } : {}),
        error,
      })

      return {
        ...base,
        ok: !unsorted && !stalled && !unreadable,
        ordersSynced: synced,
        more: true,
        ...(error ? { error } : {}),
      }
    }

    // These three are best-effort refinements of a sync that already succeeded.
    // When the deadline has passed there is no time for them, and running them
    // anyway risks the invocation being killed before the watermark below is
    // written - losing the whole run's progress to work that could have waited.
    if (opts.deadline === undefined || Date.now() < opts.deadline) {
      // Order data first, because it is the priority: close any hole the
      // incremental window can no longer reach. Deliberately ahead of the
      // catalog and customer passes - if the budget runs out, it must run out
      // on a nicety, not on a missing sale.
      try {
        const check = await reconcileRecent(shop.id, creds, {
          // Sized to THIS shop's silence, using the watermark as it stood
          // before this run: a store that went a week unreached has a week of
          // possible holes, and three days would step straight over them.
          days: reconcileWindow(shop.lastSyncAt, fetchStartedAt),
          statuses,
          deadline: opts.deadline,
        })
        added = check.added
        updated = check.updated
      } catch (e) {
        // Reported, not swallowed. A repair that dies quietly is
        // indistinguishable from a store that needed no repair, and that
        // silence is precisely what let a missing order go unnoticed for days.
        repairError = e instanceof Error ? e.message : 'Repair pass failed'
      }

      // Best-effort on a COMPLETED sync only: refresh each known product's own
      // listed price and its stock. A failure here never fails the sync - order
      // data is the priority, and the next completed sync simply retries.
      try {
        await storeCatalog(shop.id, await fetchCatalog(creds))
      } catch {
        // Retried on the next completed sync.
      }

      // Best-effort: orders from before customers were stored get theirs filled.
      try {
        await backfillCustomers(shop.id, creds)
      } catch {
        // The queue is durable - whatever is left fills on the next sync.
      }

      // Best-effort: orders from before the country was stored get theirs filled.
      try {
        await backfillDelivery(shop.id, creds)
      } catch {
        // The queue is durable - whatever is left fills on the next sync.
      }

      // Best-effort: keep the store streaming changes to us between syncs.
      try {
        await ensureWebhooks(shop.id, creds)
      } catch {
        // Live updates degrade to the scheduled sync; repaired next run.
      }
    }

    // Only now - after everything landed - does the watermark move. It moves to
    // when the FETCH began (a completed backfill starts a day back), so nothing
    // changed while we worked can slip between two windows.
    await recordRun(shop.id, {
      lastSyncAt: firstSync ? new Date(Date.now() - DAY) : fetchStartedAt,
      error: null,
    })

    return {
      ...base,
      ok: true,
      ordersSynced: synced,
      ...(added ? { added } : {}),
      ...(updated ? { updated } : {}),
      ...(repairError ? { repairError } : {}),
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Sync failed'
    // lastSyncAt is deliberately NOT updated, so the next run retries this window.
    await recordRun(shop.id, { error })
    return { ...base, ok: false, ordersSynced: 0, error }
  }
}

/**
 * Every active, connected store, longest-ignored first.
 *
 * The ordering is the whole point. With no `orderBy` nothing gave a store that
 * missed out last run any priority on the next one, so once the work outgrew the
 * budget the stores at the far end simply stopped being reached. Ordered by
 * `lastRunAt`, a run that serves K stores serves every store within ⌈N/K⌉ runs,
 * whatever N is - and because `recordRun` moves `lastRunAt` even when a store
 * fails, a permanently broken store costs one slot per run instead of holding
 * the front of the queue forever.
 *
 * Without a deadline this runs to completion, which is what the tests and any
 * one-off caller want. The scheduled route always passes one.
 */
export async function syncAllShops(opts: { deadline?: number } = {}): Promise<SyncResult[]> {
  const shops = await db.shop.findMany({
    where: { active: true, wooUrl: { not: null } },
    orderBy: { lastRunAt: { sort: 'asc', nulls: 'first' } },
    select: { id: true },
  })
  const results: SyncResult[] = []
  for (const shop of shops) {
    // Checked before the store, not after: starting one we cannot finish takes
    // the budget from a store that is already further behind.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    results.push(await syncShop(shop.id, opts))
  }
  return results
}
