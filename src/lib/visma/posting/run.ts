/**
 * Posts Dintero payouts into the Visma TEST company, one payout per run,
 * per the bookkeeper's drawing (docs/superpowers/specs/2026-09-03-visma-
 * payout-posting-design.md). Called from the scheduled sync.
 *
 * Every document is written to VismaPostingDocument as `sending` BEFORE its
 * POST. A run that dies between Visma's 201 and our own write leaves that
 * row behind, and the next run asks Visma before deciding: a payment is
 * looked up by invoice and Dintero reference; a payout entry cannot be looked
 * up reliably, so it becomes `unconfirmed` and waits for a person. Nothing
 * is ever sent twice on a guess.
 *
 * Statuses of a document: sending (POST in flight or unanswered), sent,
 * pending (to be sent; a 429 put it back), skipped (no invoice to pay - the
 * bookkeeper follows it up), error (Visma refused it), unconfirmed (may exist
 * in Visma; never resent automatically).
 */

import type { Prisma } from '@prisma/client'
import { db } from '../../db'
import { payoutIsIngested, REPORT_VERSION } from '../../dintero/sync'
import { VismaError, type VismaRequestOpts } from '../client'
import { vismaPost, writeCredentials } from '../write'
import { journalBody, paymentBody } from './dto'
import { findOurPayment, readOpenInvoices } from './invoices'
import { planPosting, type PlanMapping } from './plan'

/** 1 Oct 2026 00:00 Europe/Oslo: the bookkeeper's start date. */
export const POSTING_START = new Date('2026-09-30T22:00:00.000Z')

const MAX_CALLS = 20
const MAX_ATTEMPTS = 3
/** No call is started with less than this left of the caller's budget. */
const CALL_MARGIN_MS = 20_000
/** A `sending` row younger than this belongs to a run that may still be live (function limit is 300 s). */
const STALE_SENDING_MS = 6 * 60_000
/** Unanswered POST attempts after which a payment is no longer resent on a guess. */
const MAX_SEND_ATTEMPTS = 2

export type PostingMode = 'off' | 'dry_run' | 'hold'
export type VismaPostingResult = {
  mode: PostingMode
  configured: boolean
  payoutId: string | null
  status: string | null
  calls: number
  error: string | null
}

const PAYMENT_PATH = 'controller/api/v1/customerPayment'
const JOURNAL_PATH = 'controller/api/v2/journaltransaction'
const UNCONFIRMED =
  'Sent to Visma but the answer was lost. Look for this Dintero reference in Visma before sending it again.'

const UNANSWERED = 'unanswered POST, not found in Visma'

/** A thrown POST we cannot read as "Visma refused it": it may have been created. */
const mayExist = (e: unknown) => !(e instanceof VismaError && e.status !== undefined && e.status < 500)

async function nextPayout(tenantId: string, mode: PostingMode) {
  const done: Prisma.VismaPostingWhereInput[] = [
    { tenantId, status: 'posted' },
    { tenantId, status: 'error', attempts: { gte: MAX_ATTEMPTS } },
  ]
  // A dry run previews each payout once and never touches one a real run has
  // started; holding re-does a previewed one.
  if (mode === 'dry_run') done.push({ tenantId, status: { in: ['dry_run', 'posting', 'error'] } })
  const candidates = await db.payout.findMany({
    where: {
      settledAt: { gte: POSTING_START },
      linesPending: false,
      reportVersion: { gte: REPORT_VERSION },
      reference: { not: null },
      shop: {
        dinteroConfig: {
          vismaCustomer: { not: null },
          vismaClearingAccount: { not: null },
          vismaBankAccount: { not: null },
          vismaFeeAccount: { not: null },
        },
      },
      NOT: { vismaPostings: { some: { OR: done } } },
    },
    orderBy: { settledAt: 'asc' },
    take: 20,
    include: { lines: true, shop: { include: { dinteroConfig: true } } },
  })
  return candidates.find((p) => payoutIsIngested(p)) ?? null
}

export async function runVismaPosting(opts: { deadline?: number } = {}): Promise<VismaPostingResult> {
  let mode: PostingMode = 'off'
  const result: VismaPostingResult = { mode, configured: false, payoutId: null, status: null, calls: 0, error: null }
  // Posting id once the row exists, so a failure can be recorded instead of wedging the queue.
  let postingId: string | null = null
  try {
    const config = await db.vismaPostingConfig.findUnique({ where: { id: 'singleton' } })
    mode = (config?.mode ?? 'off') as PostingMode
    result.mode = mode
    if (mode !== 'dry_run' && mode !== 'hold') return result
    const creds = writeCredentials()
    if (!creds) return result
    result.configured = true

    const ro: VismaRequestOpts = { deadline: opts.deadline }
    // The budget counts POSTs and payment look-ups only; page reads are capped by MAX_PAGES.
    let used = 0
    const canCall = () =>
      used < MAX_CALLS && (opts.deadline === undefined || Date.now() + CALL_MARGIN_MS < opts.deadline)

    const payout = await nextPayout(creds.tenantId, mode)
    if (!payout) return result
    result.payoutId = payout.id
    const cfg = payout.shop.dinteroConfig!
    const mapping: PlanMapping = {
      customer: cfg.vismaCustomer!,
      clearingAccount: cfg.vismaClearingAccount!,
      bankAccount: cfg.vismaBankAccount!,
      feeAccount: cfg.vismaFeeAccount!,
    }
    const reference = payout.reference!

    const prior = await db.vismaPosting.findUnique({
      where: { payoutId_tenantId: { payoutId: payout.id, tenantId: creds.tenantId } },
    })
    // Another run is live if any of this posting's documents is `sending` and fresh.
    if (mode === 'hold' && prior) {
      const live = await db.vismaPostingDocument.count({
        where: { postingId: prior.id, status: 'sending', updatedAt: { gt: new Date(Date.now() - STALE_SENDING_MS) } },
      })
      if (live > 0) {
        result.status = prior.status
        return result
      }
    }
    const status = mode === 'dry_run' ? 'dry_run' : 'posting'
    const posting = await db.vismaPosting.upsert({
      where: { payoutId_tenantId: { payoutId: payout.id, tenantId: creds.tenantId } },
      create: { payoutId: payout.id, tenantId: creds.tenantId, status, attempts: 1 },
      update: { status, error: null, ...(prior?.status === 'error' ? { attempts: { increment: 1 } } : {}) },
    })
    postingId = posting.id
    result.status = status

    const read = await readOpenInvoices(creds, mapping.customer, ro)
    result.calls += read.calls
    const plan = planPosting(payout, payout.lines, read.invoices, mapping)
    const preview = JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonValue

    if (mode === 'dry_run') {
      await db.vismaPosting.update({
        where: { id: posting.id },
        data: { preview, matched: plan.payments.length, unmatched: plan.skipped.length },
      })
      return result
    }

    const doc = (kind: string, key: string) =>
      db.vismaPostingDocument.findUnique({ where: { postingId_kind_key: { postingId: posting.id, kind, key } } })
    const setDoc = (id: string, data: Prisma.VismaPostingDocumentUpdateInput) =>
      db.vismaPostingDocument.update({ where: { id }, data })

    // 1. Anything left `sending` by an earlier run: ask Visma first.
    // Only stale rows are orphans; a fresh one belongs to a run that may still be live. Every change
    // is conditional on the row being exactly as read, so a run that finishes meanwhile wins.
    const orphans = await db.vismaPostingDocument.findMany({
      where: { postingId: posting.id, status: 'sending', updatedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
    })
    const settle = async (d: { id: string; updatedAt: Date }, data: Prisma.VismaPostingDocumentUpdateManyMutationInput) =>
      db.vismaPostingDocument.updateMany({ where: { id: d.id, status: 'sending', updatedAt: d.updatedAt }, data })
    for (const d of orphans) {
      if (d.kind !== 'payment' || !d.invoiceNumber) {
        await settle(d, { status: 'unconfirmed', reason: UNCONFIRMED })
        continue
      }
      if (!canCall()) return result
      used++
      result.calls++
      let found = await findOurPayment(creds, mapping.customer, d.invoiceNumber, reference, ro)
      // A number a sibling document already holds is not ours.
      if (found) {
        const taken = await db.vismaPostingDocument.count({
          where: { postingId: posting.id, vismaNumber: found, id: { not: d.id } },
        })
        if (taken > 0) found = null
      }
      if (found) await settle(d, { status: 'sent', vismaNumber: found, reason: null })
      else if (d.attempts >= MAX_SEND_ATTEMPTS) await settle(d, { status: 'unconfirmed', reason: UNCONFIRMED })
      else await settle(d, { status: 'pending', reason: UNANSWERED })
    }

    // 2. Orders with nothing to pay: recorded once, for the bookkeeper.
    for (const s of plan.skipped) {
      if (await doc('payment', s.key)) continue
      await db.vismaPostingDocument.create({
        data: { postingId: posting.id, kind: 'payment', key: s.key, status: 'skipped', reason: s.reason },
      })
    }

    // 3. Send one document: record, POST, record the answer. False = stop this run.
    const send = async (
      kind: string,
      key: string,
      path: string,
      body: object,
      extra: { invoiceNumber?: string; amount?: number },
    ): Promise<boolean> => {
      const existing = await doc(kind, key)
      if (existing && existing.status !== 'pending' && existing.status !== 'error') return true
      if (!canCall()) return false
      let rowId: string
      if (existing) {
        // Conditional claim: an overlapping run that got here first leaves count 0.
        const claimed = await db.vismaPostingDocument.updateMany({
          where: { id: existing.id, status: { in: ['pending', 'error'] } },
          data: { status: 'sending', reason: null, attempts: { increment: 1 }, ...extra },
        })
        if (claimed.count !== 1) return false
        rowId = existing.id
      } else {
        try {
          rowId = (
            await db.vismaPostingDocument.create({
              data: { postingId: posting.id, kind, key, status: 'sending', attempts: 1, ...extra },
            })
          ).id
        } catch (e) {
          // Another run created it first: it is live, leave the posting to it.
          if ((e as { code?: string } | null)?.code === 'P2002') return false
          throw e
        }
      }
      used++
      result.calls++
      try {
        const made = await vismaPost(creds, path, body, ro)
        await setDoc(rowId, { status: 'sent', vismaNumber: made.number })
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (e instanceof VismaError && e.status === 429) {
          await setDoc(rowId, { status: 'pending' })
          return false
        }
        if (mayExist(e)) return false // stays `sending`; the next run asks Visma
        await setDoc(rowId, { status: 'error', reason: message.slice(0, 500) })
        return true
      }
    }

    for (const p of plan.payments) {
      const body = paymentBody({
        customer: mapping.customer, clearingAccount: mapping.clearingAccount, currency: payout.currency,
        reference, date: payout.settledAt!, key: p.key, invoiceNumber: p.invoiceNumber, amount: p.amount,
      })
      if (!(await send('payment', p.key, PAYMENT_PATH, body, { invoiceNumber: p.invoiceNumber, amount: p.amount }))) {
        return result
      }
    }

    if (plan.entry.length > 0) {
      const body = journalBody({ currency: payout.currency, reference, date: payout.settledAt!, lines: plan.entry })
      if (!(await send('payout', payout.id, JOURNAL_PATH, body, { amount: payout.amount }))) return result
    }

    // 4. The verdict.
    // A payment left pending whose order has since lost its invoice is the bookkeeper's now.
    const skippedBy = new Map(plan.skipped.map((s) => [s.key, s.reason]))
    const planned = new Set([...plan.payments.map((p) => p.key), ...skippedBy.keys()])
    for (const d of await db.vismaPostingDocument.findMany({
      where: { postingId: posting.id, kind: 'payment', status: 'pending' },
    })) {
      if (skippedBy.has(d.key)) {
        // Its POST may have reached Visma: never call that "nothing to pay".
        if (d.reason?.startsWith('unanswered')) await setDoc(d.id, { status: 'unconfirmed', reason: UNCONFIRMED })
        else await setDoc(d.id, { status: 'skipped', reason: skippedBy.get(d.key) })
      } else if (!planned.has(d.key)) {
        await setDoc(d.id, { status: 'skipped', reason: 'no longer in the Dintero report' })
      }
    }
    const docs = await db.vismaPostingDocument.findMany({ where: { postingId: posting.id } })
    const failed = docs.find((d) => d.status === 'error' || d.status === 'unconfirmed')
    const open = docs.some((d) => d.status === 'pending' || d.status === 'sending')
    if (!failed && open) return result // still `posting`: something is unsent
    const final = failed ? 'error' : 'posted'
    await db.vismaPosting.update({
      where: { id: posting.id },
      data: {
        status: final,
        error: failed?.reason ?? null,
        matched: docs.filter((d) => d.kind === 'payment' && d.status === 'sent').length,
        unmatched: docs.filter((d) => d.kind === 'payment' && d.status === 'skipped').length,
        postedAt: failed ? null : new Date(),
        preview,
      },
    })
    result.status = final
    return result
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Visma posting failed'
    if (postingId && mode === 'dry_run') {
      // A dry run creates no documents: forget the failed preview so it is tried again.
      try {
        await db.vismaPosting.deleteMany({ where: { id: postingId, documents: { none: {} } } })
      } catch {
        // the original error is the one to report
      }
    } else if (postingId) {
      // Record it, so a payout that always fails runs out of attempts instead of wedging the queue.
      // (attempts was already counted when this run claimed the posting.)
      try {
        await db.vismaPosting.update({
          where: { id: postingId },
          data: { status: 'error', error: result.error.slice(0, 500) },
        })
        result.status = 'error'
      } catch {
        // the original error is the one to report
      }
    }
    return result
  }
}
