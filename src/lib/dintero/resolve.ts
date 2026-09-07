/**
 * Asking Dintero, order by order, which payout paid it.
 *
 * Everything else here is built from settlement reports, which can only ever
 * answer "this order is in no payout WE HOLD". An order paid out before our
 * imported history begins therefore looks exactly like an order that was never
 * paid - and that is what sent the client to Dintero's support by email, only
 * to be told all three orders had been paid out, with the reports attached.
 *
 * Dintero's transaction endpoint answers the question outright: each
 * transaction event carries `settlements.events[]`, "one item per payout to
 * the merchants bank account", with the settlement id on it. That is the same
 * thing Backoffice shows under History. Given the id we can fetch that one
 * settlement by search, ingest its report, and the order matches through the
 * ordinary path - no hand-made links anywhere.
 */
import { db } from '../db'
import { decryptSecret } from '../secrets'
import {
  DinteroApiError,
  getToken,
  getTransaction,
  listSettlements,
  pickJsonReport,
  type DinteroCredentials,
} from './client'
import { ingestReport, payoutIsIngested, upsertPayout } from './sync'

/**
 * Payouts arrive weekly, so a captured order should be inside one within a
 * week; a day of slack on top keeps the fresh weekend out of the list. The
 * same number the payouts page uses to decide what is "waiting".
 */
const WAITING_AFTER_DAYS = 8

/** Statuses where the money was captured - what a payout should contain. */
const CAPTURED_STATUSES = ['completed', 'processing', 'shipping']

/**
 * Orders asked about per run. One transaction call each, and at most one
 * settlement fetch and report download on top. At four runs an hour this
 * works through a two-thousand-order backlog in a couple of days and then has
 * almost nothing to do.
 */
const MAX_ORDERS_PER_RUN = 20

/**
 * How long an answer stands before the same order is asked about again.
 *
 * An order Dintero says is not settled yet will be settled eventually, so the
 * question is worth repeating - but not every fifteen minutes, which would
 * spend the whole run's budget re-asking about the same orders and never reach
 * the ones behind them.
 */
const ASK_AGAIN_AFTER_DAYS = 7

export type ResolveResult = {
  configured: boolean
  /** Orders we actually asked Dintero about. */
  checked: number
  /** Orders that now sit in a payout because of this run. */
  resolved: number
  /** Settlements we did not hold and have now imported. */
  imported: number
  /** Payouts whose stored report did not contain the transaction, queued for a re-read. */
  requeued: number
  /** Orders Dintero says it has not paid out yet. */
  unsettled: number
  errors: string[]
}

const none = (configured: boolean): ResolveResult => ({
  configured,
  checked: 0,
  resolved: 0,
  imported: 0,
  requeued: 0,
  unsettled: 0,
  errors: [],
})

/** Remember what Dintero said, so the same order is not asked again tomorrow. */
async function stamp(orderId: string, note: string): Promise<void> {
  await db.order
    .update({ where: { id: orderId }, data: { payoutCheckedAt: new Date(), payoutCheckNote: note } })
    .catch(() => {
      // Bookkeeping is never worth failing the run over.
    })
}

export async function resolveUnpaidOrders(
  opts: { deadline?: number; maxOrders?: number; shopId?: string } = {},
): Promise<ResolveResult> {
  const max = opts.maxOrders ?? MAX_ORDERS_PER_RUN
  const configs = await db.dinteroConfig.findMany({
    where: { active: true, ...(opts.shopId ? { shopId: opts.shopId } : {}) },
    include: { shop: { select: { name: true } } },
  })
  if (configs.length === 0 || max <= 0) return none(configs.length > 0)

  const cutoff = new Date(Date.now() - WAITING_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const askAgain = new Date(Date.now() - ASK_AGAIN_AFTER_DAYS * 24 * 60 * 60 * 1000)

  /**
   * Deliberately WITHOUT the payouts page's coverage floor.
   *
   * That floor exists so the page does not show pre-coverage orders as debts
   * to chase, which is right for a list built on guesswork. Here it would
   * exclude exactly the orders worth asking about: the ones paid out before
   * our imported history, which is where the three the client asked Dintero
   * about turned out to live.
   */
  const due = await db.order.findMany({
    where: {
      shopId: { in: configs.map((c) => c.shopId) },
      status: { in: CAPTURED_STATUSES },
      voidedAt: null,
      payoutLines: { none: {} },
      placedAt: { lte: cutoff },
      OR: [{ payoutCheckedAt: null }, { payoutCheckedAt: { lte: askAgain } }],
      AND: [
        {
          OR: [
            { AND: [{ transactionId: { not: null } }, { transactionId: { not: '' } }] },
            { AND: [{ dinteroReference: { not: null } }, { dinteroReference: { not: '' } }] },
          ],
        },
      ],
    },
    // Never asked first, then the oldest answer; within that, the oldest order.
    orderBy: [{ payoutCheckedAt: { sort: 'asc', nulls: 'first' } }, { placedAt: 'asc' }],
    take: max,
    select: { id: true, shopId: true, number: true, transactionId: true },
  })
  if (due.length === 0) return none(true)

  const result = none(true)
  const byShop = new Map(configs.map((c) => [c.shopId, c]))
  /** One token per shop per run, and a shop that refused is not asked again. */
  const tokens = new Map<string, string>()
  const refused = new Set<string>()

  for (const order of due) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) break
    const config = byShop.get(order.shopId)
    if (!config || refused.has(order.shopId)) continue

    // Only a transaction id can be looked up. dinteroReference is the
    // plugin's session id, which this endpoint does not take - such an order
    // qualifies for the list but has nothing to ask with, so it waits for the
    // transaction-id backfill instead of being marked answered.
    const transactionId = order.transactionId
    if (!transactionId) continue

    const creds: DinteroCredentials = {
      accountId: config.accountId,
      clientId: decryptSecret(config.clientId),
      clientSecret: decryptSecret(config.clientSecret),
    }

    try {
      let token = tokens.get(order.shopId)
      if (!token) {
        token = await getToken(creds)
        tokens.set(order.shopId, token)
      }

      const tx = await getTransaction(creds, token, transactionId)
      result.checked++

      if (tx === null) {
        await stamp(order.id, 'Dintero does not know this transaction.')
        continue
      }
      if (tx.settlements.length === 0) {
        result.unsettled++
        await stamp(
          order.id,
          `Dintero says this is not settled yet (${tx.settlementStatus ?? 'no settlement status'}).`,
        )
        continue
      }

      let linked = false
      for (const settlement of tx.settlements) {
        let payout = await db.payout.findUnique({
          where: { shopId_externalId: { shopId: order.shopId, externalId: settlement.settlementId } },
        })

        if (!payout) {
          // The settlement is outside what the list walks. Its id is enough to
          // ask for it directly - `search` matches a settlement id.
          const [found] = await listSettlements(creds, token, { search: settlement.settlementId })
          if (!found) continue
          payout = await upsertPayout(order.shopId, found)
          const attachmentId = pickJsonReport(found.attachments)
          if (attachmentId && !payoutIsIngested(payout)) {
            await ingestReport(creds, token, payout.id, found.id, attachmentId)
          }
          result.imported++
        }

        const line = await db.payoutLine.findFirst({
          where: { payoutId: payout.id, transactionId },
          select: { id: true, orderId: true },
        })
        if (!line) {
          // The payout is here and its report was read, but it holds no line
          // for this transaction - so what we stored is wrong or stale. Ask
          // for the report again rather than inventing a line.
          await db.payout.update({ where: { id: payout.id }, data: { linesPending: true } })
          result.requeued++
          continue
        }
        if (line.orderId === null) {
          // Dintero has just said this transaction is in this settlement, and
          // this is the order we asked about. That is better evidence than the
          // reference matcher, which has already declined this line once and
          // would decline it again.
          await db.payoutLine.update({ where: { id: line.id }, data: { orderId: order.id } })
        }
        linked = true
      }

      if (linked) result.resolved++
      else await stamp(order.id, `Dintero says it was paid in ${tx.settlements[0].settlementId}.`)
    } catch (e) {
      if (!(e instanceof DinteroApiError)) console.error('dintero resolve', config.shop.name, e)
      const error =
        e instanceof DinteroApiError
          ? e.message
          : 'The Dintero settlement lookup failed. It retries on the next run.'
      // One refusal answers for the whole shop: the credentials or the scope
      // are the same for every order behind it, and asking 19 more times only
      // spends the run.
      refused.add(order.shopId)
      result.errors.push(`${config.shop.name}: ${error}`)
      await db.dinteroConfig
        .update({ where: { id: config.id }, data: { lastError: error } })
        .catch(() => {})
    }
  }

  return result
}
