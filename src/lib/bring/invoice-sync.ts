import { db } from '../db'
import { getDeliveryConfig } from '../delivery/config'
import { monthlyInvoiceTotals } from '../delivery/invoiced-cost'
import { buildRateTable } from '../metrics/fx'
import { loadRates } from '../fx/rates'
import type { BringCredentials, BringFilter } from './client'
import { linesReconcile, parseSpecifiedInvoice } from './invoice-lines'
import type { BringInvoice } from './invoice-map'
import { downloadReport, generateSpecReport, listCustomerNumbers, listInvoices, reportStatus } from './invoices'

const HOUR = 60 * 60 * 1000

/**
 * How long a FAILED row sits out before requestNextReport will retry it.
 *
 * FAILED is written for causes from a genuine 500 down to a starved tick
 * aborting at its own deadline (see the deadline guards on requestNextReport
 * and collectNextReport below) to an invoice that will never reconcile.
 * Without a backoff, a permanently-broken invoice would be retried on every
 * fifteen-minute tick forever — one of the tick's few request slots spent on
 * a hopeless row — and, because selection is oldest-first, would starve every
 * invoice behind it for as long as it kept winning that ordering. One hour
 * matches delivery/sync.ts's own backoff for a single dead parcel: long
 * enough that a broken row costs at most a handful of wasted ticks a day,
 * short enough that a transient failure — a 500, a timeout, a dropped
 * connection — clears within the hour rather than sitting for a working day.
 */
const RETRY_AFTER_MS = HOUR

/**
 * How long a REQUESTED row may sit with no resolution before collectNextReport
 * gives up on it and asks Bring to build a fresh report.
 *
 * Measured, the real report was DONE on its very first status check, so six
 * hours — twenty-four polls at the cron's fifteen-minute cadence — is a wide
 * margin over the legitimate case, not a tight guess. Below it, a `NOT_DONE`
 * report gets every reasonable chance to finish. Above it — or if Bring's
 * status body ever changes shape and simply stops matching DONE or FAILED —
 * this is what stops the row sitting at the head of the oldest-first queue
 * forever, promoting nothing behind it: the exact freeze invoices.ts's own
 * reportStatus comment names.
 */
const STALE_REQUESTED_MS = 6 * HOUR

/**
 * Turn every invoice we have not seen into a job.
 *
 * Cheap: one call to enumerate customers, one per customer to list invoices.
 * It writes nothing but rows, so a tick that discovers and then runs out of
 * time has still moved the work forward.
 *
 * Checked before the first request and before each customer after it,
 * because listCustomerNumbers and listInvoices are Bring requests like any
 * other: past the deadline, requestBudgetMs clamps the next one to 1ms and it
 * aborts almost immediately, which is a throw a caller has no way to tell
 * apart from a genuine failure. `partial` reports that this stopped early for
 * that reason instead — still true, never an error, and never a reason to
 * discard what it already found.
 */
export async function discoverInvoices(
  creds: BringCredentials,
  opts: BringFilter = {},
): Promise<{
  found: number
  queued: number
  noSpec: number
  partial: boolean
  /**
   * Every invoice seen this pass, whether or not it was new.
   *
   * Carried out rather than counted because the monthly totals are built from
   * ALL of a month's invoices, not just the ones we had not seen before. This
   * is already in hand: listing them is what this function does, so handing
   * them back costs nothing and saves a second pass over the same API.
   */
  invoices: BringInvoice[]
}> {
  let found = 0
  let queued = 0
  let noSpec = 0
  const seen: BringInvoice[] = []

  // Before the very first request too, not just inside the loop below:
  // listCustomerNumbers is a Bring request in its own right, not a local
  // read, so a tick that starts already past its deadline must not even
  // attempt it.
  if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
    return { found, queued, noSpec, partial: true, invoices: seen }
  }

  for (const customerNumber of await listCustomerNumbers(creds, opts)) {
    // Checked before each customer: its invoice list is one more request, and
    // starting one we cannot finish burns the run's last seconds for nothing.
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      return { found, queued, noSpec, partial: true, invoices: seen }
    }
    for (const invoice of await listInvoices(creds, customerNumber, opts)) {
      found += 1
      seen.push(invoice)
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

  return { found, queued, noSpec, partial: false, invoices: seen }
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
  // Checked before the row is even read. requestBudgetMs floors an expired
  // budget at 1ms rather than refusing outright, so past the deadline
  // generateSpecReport would abort almost immediately and the catch below
  // would write that abort onto the row as FAILED — burying the oldest
  // PENDING invoice every fifteen minutes that a tick starves, under a
  // message no reader could tell apart from a genuine failure. Same shape as
  // discoverInvoices' guard above.
  if (opts.deadline !== undefined && Date.now() >= opts.deadline) return false

  const now = new Date()
  const next = await db.bringReportRun.findFirst({
    where: {
      OR: [
        { state: 'PENDING' },
        // FAILED is NOT terminal — only NO_SPEC is, and the spec justifies
        // NO_SPEC precisely as the state that stops something being retried
        // forever, which only means anything if FAILED is retried. Everything
        // else writes FAILED: a 500, a dropped connection, a report that never
        // built, an invoice that did not reconcile. Once the backoff has
        // elapsed the row comes back round and gets a fresh report generated.
        //
        // `nextTryAt: null` counts as due rather than as never. A bare `lte`
        // would make any FAILED row without one invisible to this query for
        // good, which is the trap Shipment.nextPollAt already carries a
        // comment about; a row can only lack one if something outside this
        // file wrote it, and the safe reading of that is to try it.
        { state: 'FAILED', OR: [{ nextTryAt: null }, { nextTryAt: { lte: now } }] },
      ],
    },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!next) return false

  try {
    const statusUrl = await generateSpecReport(creds, next.customerNumber, next.invoiceNumber, opts)
    await db.bringReportRun.update({
      where: { id: next.id },
      // Both the old error and the old backoff are cleared: a stale message
      // sitting beside a REQUESTED state reads as a live problem, and a stale
      // nextTryAt would delay the next genuine failure by whatever was left
      // of the previous hour.
      data: { state: 'REQUESTED', statusUrl, requestedAt: now, error: null, nextTryAt: null },
    })
  } catch (e) {
    // Stored, never thrown. One dead invoice must not stop the rest — the same
    // rule delivery/sync.ts follows for one dead parcel.
    //
    // The recovery write is itself guarded, exactly as delivery/sync.ts guards
    // its own. Without the .catch a database blip DURING the write would throw
    // out of here, past the collect stage, and land in syncBringInvoices as a
    // run-level error — one failure reported as two, and the collect skipped
    // for a reason unrelated to it. Swallowed, the row simply stays PENDING and
    // comes round again next tick, which is where it belonged anyway.
    await db.bringReportRun
      .update({
        where: { id: next.id },
        data: {
          state: 'FAILED',
          error: e instanceof Error ? e.message : String(e),
          nextTryAt: new Date(now.getTime() + RETRY_AFTER_MS),
        },
      })
      .catch(() => {})
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
  // The same guard, for the same reason: reportStatus, downloadReport and
  // listInvoices are all Bring requests, and past the deadline each would be
  // clamped to a 1ms budget and abort into fail() below.
  if (opts.deadline !== undefined && Date.now() >= opts.deadline) return null

  const job = await db.bringReportRun.findFirst({
    where: { state: 'REQUESTED', statusUrl: { not: null } },
    orderBy: { invoiceDate: 'asc' },
  })
  if (!job) return null

  const fail = async (message: string) => {
    // Guarded like requestNextReport's, and for the same reason: this runs
    // from inside the catch below, so a throw here escapes the function
    // entirely and is reported as a run-level failure. Left unwritten, the row
    // stays REQUESTED and is either collected next tick or aged out by
    // STALE_REQUESTED_MS — both better than losing the tick.
    await db.bringReportRun
      .update({
        where: { id: job.id },
        // Carries a backoff, because requestNextReport picks FAILED rows back
        // up. Without one, a row that fails here would be re-requested on the
        // very next tick and, being oldest-first, would win that ordering
        // every time and starve every invoice behind it.
        data: { state: 'FAILED', error: message, nextTryAt: new Date(Date.now() + RETRY_AFTER_MS) },
      })
      .catch(() => {})
    return null
  }

  // A REQUESTED row this old is not waiting, it is wedged: parked on NOT_DONE
  // for good, or answering a status shape this code stopped recognising. Aged
  // out WITHOUT asking Bring first, because a status endpoint that never
  // resolves is the very thing this guards against, so the fix cannot depend
  // on calling it. It becomes a FAILED row like any other, which
  // requestNextReport then asks for again from scratch once the backoff
  // elapses.
  //
  // Only when requestedAt is set. Nothing but requestNextReport writes
  // REQUESTED and it always stamps one, so a row without it came from
  // somewhere else and there is no honest age to measure.
  if (job.requestedAt && Date.now() - job.requestedAt.getTime() > STALE_REQUESTED_MS) {
    return fail('Bring never finished building this report, so it will be asked for again')
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
      //
      // The skip count separates the two causes that produce an identical
      // shortfall: a truncated download drops trailing lines and leaves it at
      // 0, while a line the parser could not read — an invoice-level charge
      // carrying no waybill, say — leaves it non-zero. Those need different
      // answers from whoever reads this message.
      const skipped =
        parsed.skipped > 0
          ? `; ${parsed.skipped} line${parsed.skipped === 1 ? '' : 's'} could not be read`
          : ''
      return fail(
        `The report's lines do not reconcile with the invoice total (${header.amountMinor} minor units)${skipped}`,
      )
    }

    // Wholesale replace, and the unmatched count and the STORED update ride in
    // the same transaction as the replace itself. The report carries no line
    // identifier, so delete-then-recreate — not a unique constraint — is what
    // makes re-reading safe; folding the rest in here means a failure after
    // the lines are written can never leave them committed while the row that
    // describes them says FAILED, which nothing would ever retry.
    const { stored, unmatched } = await db.$transaction(async (tx) => {
      await tx.shipmentCost.deleteMany({ where: { invoiceNumber: job.invoiceNumber } })
      const { count } = await tx.shipmentCost.createMany({
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

      // How much of this invoice we could not attach to a parcel we hold.
      // Counted rather than hidden: it is the number that says whether the
      // join works.
      const known = await tx.shipment.findMany({
        where: { trackingNumber: { in: [...new Set(parsed.lines.map((l) => l.waybillNumber))] } },
        select: { trackingNumber: true },
      })
      const have = new Set(known.map((s) => s.trackingNumber))
      const unmatched = parsed.lines.filter((l) => !have.has(l.waybillNumber)).length

      await tx.bringReportRun.update({
        where: { id: job.id },
        data: {
          state: 'STORED', collectedAt: new Date(),
          rowsStored: count, rowsUnmatched: unmatched, error: null,
        },
      })
      return { stored: count, unmatched }
    })
    return { stored, unmatched }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/** The workspace currency and today's rates, loaded once per tick. */
async function displayFrame(): Promise<{ currency: string; rates: Awaited<ReturnType<typeof buildRateTable>> }> {
  const [{ displayCurrency }, rows] = await Promise.all([
    (await import('../settings')).getSetting(),
    loadRates(),
  ])
  return { currency: displayCurrency, rates: buildRateTable(rows) }
}

/** The month after the one `day` falls in, both as 'YYYY-MM'. */
function monthAfter(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * Fill in what Bring billed, per month, so nobody has to type it.
 *
 * Only months that have ENDED. An invoice-dated month still running has only
 * some of its invoices in, while the parcels for it keep arriving, so the
 * division would read low and then creep upwards all month. A figure that
 * moves under the reader is worse than one that arrives a few days late.
 *
 * Only months COUNTED FROM THEIR FIRST DAY. `countingFrom` is when the parcel
 * record became complete; the card divides a month's bill by that month's
 * parcels, and for the month counting began part-way through, the bill covers
 * the whole month while the parcels do not. Measured on 2026-08-21: parcels
 * held from 12 August, so August's figure would have read roughly 1.5x the
 * true cost — as the first automatic number the client ever saw. Months from
 * before the boundary that this writer created earlier are DELETED, not just
 * skipped: July held one stray parcel, so its auto-written 324 814.90 kr
 * total stood ready to display as 324 814.90 kr PER PARCEL.
 *
 * Never touches a row a person typed — written or deleted. Someone who
 * corrected a figure knows something this importer does not - a credit note,
 * a month split across two accounts - and silently overwriting that is the
 * one behaviour that would make the whole panel untrustworthy.
 */
export async function writeBringCosts(
  invoices: BringInvoice[],
  countingFrom: Date | null,
  now = new Date(),
): Promise<number> {
  if (invoices.length === 0) return 0
  // No parcels counted yet means no divisor exists for any month, so there is
  // nothing an invoice total could honestly be divided by.
  if (!countingFrom) return 0
  const { currency, rates } = await displayFrame()
  const thisMonth = now.toISOString().slice(0, 7)

  const fromDay = countingFrom.toISOString().slice(0, 10)
  const firstMonth = fromDay.endsWith('-01') ? fromDay.slice(0, 7) : monthAfter(fromDay.slice(0, 7))

  // Self-healing, not one-off migration: rows written before the boundary rule
  // existed disappear on the next tick, and keep disappearing if the boundary
  // ever moves later. Scoped to source 'bring' — a typed figure is his.
  await db.carrierCost.deleteMany({
    where: { carrier: 'BRING', source: 'bring', month: { lt: firstMonth } },
  })

  const totals = monthlyInvoiceTotals(invoices, currency, rates).filter(
    (t) => t.month < thisMonth && t.month >= firstMonth,
  )

  let written = 0
  for (const total of totals) {
    const held = await db.carrierCost.findUnique({
      where: { carrier_month: { carrier: 'BRING', month: total.month } },
      select: { source: true },
    })
    if (held?.source === 'typed') continue

    await db.carrierCost.upsert({
      where: { carrier_month: { carrier: 'BRING', month: total.month } },
      create: {
        carrier: 'BRING', month: total.month,
        amount: total.amountMinor, currency: total.currency, source: 'bring',
      },
      update: { amount: total.amountMinor, currency: total.currency, source: 'bring' },
    })
    written += 1
  }
  return written
}

/**
 * When the parcel record became complete: the earliest deliveryTrackingFrom
 * any active shop declares.
 *
 * The system's own declared boundary, NOT min(Shipment date) — deliberately.
 * Production holds one stray parcel with a July billable date among a record
 * that otherwise starts 12 August (measured 2026-08-21), so a data-derived
 * boundary lands in July and admits August as a fully-counted month when
 * eleven days of it were never recorded. deliveryTrackingFrom already means
 * "judge nothing older than this" everywhere else on the Delivery page; a
 * month's cost average is a judgement like any other. Null — no shop declares
 * one — means the record has no stated start, and nothing is written.
 */
async function trackingEraStart(): Promise<Date | null> {
  const m = await db.shop.aggregate({
    where: { active: true, deliveryTrackingFrom: { not: null } },
    _min: { deliveryTrackingFrom: true },
  })
  return m._min.deliveryTrackingFrom
}

export type BringInvoiceSyncResult = {
  configured: boolean
  found: number
  queued: number
  noSpec: number
  // Discovery stopped early because the deadline had already passed, not
  // because there was nothing left to find. Distinct from `error`: a partial
  // tick did its share of the work honestly and picks up where it left off
  // next tick, exactly like a store cut off by SHOPS_DEADLINE_MS.
  partial: boolean
  requested: boolean
  stored: number
  unmatched: number
  /** Months whose Bring invoice total was filled in from the archive. */
  costMonths: number
  error: string | null
}

const nothing = (over: Partial<BringInvoiceSyncResult> = {}): BringInvoiceSyncResult => ({
  configured: true, found: 0, queued: 0, noSpec: 0, partial: false,
  requested: false, stored: 0, unmatched: 0, costMonths: 0, error: null, ...over,
})

/**
 * One tick: discover, request one, collect one.
 *
 * Deliberately at most one of each. The report API is asynchronous and this
 * runs inside a 300-second invocation that the shop sync, four Visma imports,
 * the parcel poll and the delivery alert also have to fit into. A backlog
 * clears over several hours of ticks, which costs nobody anything; a tick that
 * ran the whole backlog would cost the delivery alert its margin.
 */
export async function syncBringInvoices(
  opts: BringFilter = {},
): Promise<BringInvoiceSyncResult> {
  try {
    // getDeliveryConfig's own docstring promises it never throws, but it does
    // a findUnique, so it is guarded here like every other caller of it (see
    // src/lib/bring/import.ts) rather than trusted on faith. Inside the try,
    // not before it: outside, a genuine database failure would be reported
    // identically to Bring simply not being connected, and the message that
    // would have said otherwise is lost.
    const { creds } = await getDeliveryConfig()
    if (!creds) return nothing({ configured: false })

    const found = await discoverInvoices(creds, opts)
    // Only on a complete pass. A discovery cut short by the deadline has seen
    // some customers and not others, and a month totalled from half its
    // invoices would be written as though it were the whole thing.
    const costMonths = found.partial ? 0 : await writeBringCosts(found.invoices, await trackingEraStart())
    const requested = await requestNextReport(creds, opts)
    const collected = await collectNextReport(creds, opts)
    return nothing({
      found: found.found, queued: found.queued, noSpec: found.noSpec,
      partial: found.partial,
      requested,
      stored: collected?.stored ?? 0,
      unmatched: collected?.unmatched ?? 0,
      costMonths,
    })
  } catch (e) {
    return nothing({ error: e instanceof Error ? e.message : String(e) })
  }
}
