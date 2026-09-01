import { db } from '../db'
import { decryptSecret } from '../secrets'
import {
  DinteroApiError,
  downloadReport,
  getToken,
  listSettlements,
  pickJsonReport,
} from './client'

/**
 * Payouts land once a week per shop, so six-hour spacing - the ads' and
 * Klaviyo's cadence - already checks four times as often as the data moves.
 */
const MIN_HOURS_BETWEEN = 6

/**
 * Report downloads per run, across all shops. The first run against an
 * account with years of history stays bounded and the backlog drains over
 * the next few ticks; a steady week is one download per shop.
 */
const MAX_REPORTS_PER_RUN = 40

/**
 * A shop still owing report downloads goes again after half an hour instead
 * of six - the backlog drains within the hour of a connect, without a shop
 * whose reports never appear hammering Dintero every fifteen minutes.
 */
const BACKLOG_MINUTES_BETWEEN = 30

export type DinteroSyncResult = {
  configured: boolean
  ok: boolean
  /** Payout headers written or refreshed this run. */
  payouts: number
  /** Report lines stored this run. */
  lines: number
  /** Lines now pointing at one of our orders, this run. */
  matched: number
  /** Lines still pointing at no order after matching, this run. */
  unmatched: number
  /** True when every connection was fresh enough that Dintero was not asked. */
  skippedFresh?: true
  /** One entry per failing shop; the connection keeps its own lastError too. */
  errors: string[]
}

/**
 * Mirror every connected shop's settlements into Payout/PayoutLine and match
 * each line to the order wearing its reference.
 *
 * The whole settlement list is re-read each due run - weekly payouts make
 * that a few hundred rows a year - so a settlement that changes after the
 * fact (postponed to paid) corrects itself and there is no watermark to
 * lose. Reports are downloaded once: their lines never change once paid.
 * Failure keeps the previous rows standing; stale payouts beat a table that
 * empties itself whenever Dintero has a bad morning.
 */
export async function syncDinteroPayouts(
  opts: { force?: boolean; deadline?: number; shopId?: string } = {},
): Promise<DinteroSyncResult> {
  const configs = await db.dinteroConfig.findMany({
    // shopId narrows the run to one connection - the connect route imports
    // the shop it just connected without forcing eight other shops with it.
    where: { active: true, ...(opts.shopId ? { shopId: opts.shopId } : {}) },
    include: { shop: { select: { id: true, name: true } } },
  })
  if (configs.length === 0) {
    return { configured: false, ok: true, payouts: 0, lines: 0, matched: 0, unmatched: 0, errors: [] }
  }

  const now = new Date()
  // Payouts whose report is still owed: never downloaded, or ingested as
  // empty with no reference - the state a misread report leaves behind.
  const owing = new Set(
    (
      await db.payout.groupBy({
        by: ['shopId'],
        where: {
          shopId: { in: configs.map((c) => c.shopId) },
          OR: [{ linesPending: true }, { reference: null, lines: { none: {} } }],
        },
      })
    ).map((g) => g.shopId),
  )
  const due = opts.force
    ? configs
    : configs.filter((c) => {
        if (!c.lastSyncAt) return true
        const age = now.getTime() - c.lastSyncAt.getTime()
        if (owing.has(c.shopId)) return age >= BACKLOG_MINUTES_BETWEEN * 60_000
        return age >= MIN_HOURS_BETWEEN * 3_600_000
      })
  if (due.length === 0) {
    return {
      configured: true, ok: true, payouts: 0, lines: 0, matched: 0, unmatched: 0,
      skippedFresh: true, errors: [],
    }
  }

  const result: DinteroSyncResult = {
    configured: true, ok: true, payouts: 0, lines: 0, matched: 0, unmatched: 0, errors: [],
  }
  let reportBudget = MAX_REPORTS_PER_RUN

  for (const config of due) {
    // Out of time is not an error: the connection stays unstamped and goes
    // first next run, exactly like a store the shop sync never reached.
    if (opts.deadline && Date.now() >= opts.deadline) break

    try {
      const creds = {
        accountId: config.accountId,
        clientId: decryptSecret(config.clientId),
        clientSecret: decryptSecret(config.clientSecret),
      }
      const token = await getToken(creds)
      const settlements = await listSettlements(creds, token, {
        payoutDestinationId: config.payoutDestinationId,
      })

      // Which payouts already hold lines: those reports are ingested for
      // good, whatever their reference says.
      const withLines = new Set(
        (
          await db.payoutLine.groupBy({
            by: ['payoutId'],
            where: { payout: { shopId: config.shopId } },
          })
        ).map((g) => g.payoutId),
      )

      for (const s of settlements) {
        const header = {
          provider: s.provider,
          settledAt: s.settledAt,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          currency: s.currency,
          amount: s.amount,
          capture: s.capture,
          refund: s.refund,
          fee: s.fee,
        }
        const payout = await db.payout.upsert({
          where: { shopId_externalId: { shopId: config.shopId, externalId: s.id } },
          create: { shopId: config.shopId, externalId: s.id, ...header },
          update: header,
        })
        result.payouts++

        // Ingested means lines stored, or a reference proving the report was
        // truly read and truly empty. No lines AND no reference is the trail
        // of a misread report - downloaded again until it speaks.
        const ingested =
          !payout.linesPending && (payout.reference !== null || withLines.has(payout.id))
        if (ingested || reportBudget <= 0) continue
        if (opts.deadline && Date.now() >= opts.deadline) break
        const attachmentId = pickJsonReport(s.attachments)
        if (!attachmentId) continue

        reportBudget--
        const report = await downloadReport(creds, token, s.id, attachmentId)
        // Wholesale replace, atomically: half a report's lines under a
        // "report stored" flag would be a payout quietly missing orders.
        await db.$transaction([
          db.payoutLine.deleteMany({ where: { payoutId: payout.id } }),
          db.payoutLine.createMany({
            data: report.lines.map((l) => ({
              payoutId: payout.id,
              transactionId: l.transactionId,
              reference: l.reference,
              amount: l.amount,
              capture: l.capture,
              refund: l.refund,
              fee: l.fee,
              transactionDate: l.transactionDate,
              paymentType: l.paymentType,
              cardBrand: l.cardBrand,
            })),
          }),
          db.payout.update({
            where: { id: payout.id },
            data: { reference: report.reference, linesPending: false },
          }),
        ])
        result.lines += report.lines.length
      }

      // Match every line of this shop's payouts that still points at no
      // order - the fresh ones and any the order sync had not caught up
      // with last time. By number first (what the checkout usually sends),
      // then by the Woo order id, always within this shop: order numbers
      // repeat across nine webshops.
      const open = await db.payoutLine.findMany({
        where: { orderId: null, payout: { shopId: config.shopId } },
        select: { id: true, reference: true },
      })
      if (open.length > 0) {
        const refs = [...new Set(open.map((l) => l.reference).filter((r) => r !== ''))]
        const orders = await db.order.findMany({
          where: { shopId: config.shopId, OR: [{ number: { in: refs } }, { externalId: { in: refs } }] },
          select: { id: true, number: true, externalId: true },
        })
        const byNumber = new Map(orders.map((o) => [o.number, o.id]))
        const byWooId = new Map(orders.map((o) => [o.externalId, o.id]))

        for (const line of open) {
          const orderId = byNumber.get(line.reference) ?? byWooId.get(line.reference)
          if (orderId) {
            await db.payoutLine.update({ where: { id: line.id }, data: { orderId } })
            result.matched++
          } else {
            result.unmatched++
          }
        }
      }

      await db.dinteroConfig.update({
        where: { id: config.id },
        data: { lastSyncAt: new Date(), lastError: null },
      })
    } catch (e) {
      // Provider wording is safe to show; anything else gets a plain
      // sentence rather than a stack trace on the settings page.
      const error =
        e instanceof DinteroApiError ? e.message : 'The Dintero sync failed. It retries on the next run.'
      result.ok = false
      result.errors.push(`${config.shop.name}: ${error}`)
      await db.dinteroConfig
        .update({ where: { id: config.id }, data: { lastError: error } })
        .catch(() => {})
    }
  }

  return result
}
