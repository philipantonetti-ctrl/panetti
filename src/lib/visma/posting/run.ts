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
import { payoutIsIngested } from '../../dintero/sync'
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
  try {
    const config = await db.vismaPostingConfig.findUnique({ where: { id: 'singleton' } })
    mode = (config?.mode ?? 'off') as PostingMode
    result.mode = mode
    if (mode !== 'dry_run' && mode !== 'hold') return result
    const creds = writeCredentials()
    if (!creds) return result
    result.configured = true

    const ro: VismaRequestOpts = { deadline: opts.deadline }
    const canCall = () =>
      result.calls < MAX_CALLS && (opts.deadline === undefined || Date.now() + CALL_MARGIN_MS < opts.deadline)

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
    const status = mode === 'dry_run' ? 'dry_run' : 'posting'
    const posting = await db.vismaPosting.upsert({
      where: { payoutId_tenantId: { payoutId: payout.id, tenantId: creds.tenantId } },
      create: { payoutId: payout.id, tenantId: creds.tenantId, status, attempts: 1 },
      update: { status, error: null, ...(prior?.status === 'error' ? { attempts: { increment: 1 } } : {}) },
    })
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
    for (const d of await db.vismaPostingDocument.findMany({ where: { postingId: posting.id, status: 'sending' } })) {
      if (d.kind !== 'payment' || !d.invoiceNumber) {
        await setDoc(d.id, { status: 'unconfirmed', reason: UNCONFIRMED })
        continue
      }
      if (!canCall()) return result
      result.calls++
      const found = await findOurPayment(creds, mapping.customer, d.invoiceNumber, reference, ro)
      await setDoc(d.id, found ? { status: 'sent', vismaNumber: found, reason: null } : { status: 'pending' })
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
      const row = existing
        ? await setDoc(existing.id, { status: 'sending', reason: null, ...extra })
        : await db.vismaPostingDocument.create({
            data: { postingId: posting.id, kind, key, status: 'sending', ...extra },
          })
      result.calls++
      try {
        const made = await vismaPost(creds, path, body, ro)
        await setDoc(row.id, { status: 'sent', vismaNumber: made.number })
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (e instanceof VismaError && e.status === 429) {
          await setDoc(row.id, { status: 'pending' })
          return false
        }
        if (mayExist(e)) return false // stays `sending`; the next run asks Visma
        await setDoc(row.id, { status: 'error', reason: message.slice(0, 500) })
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
    const docs = await db.vismaPostingDocument.findMany({ where: { postingId: posting.id } })
    const failed = docs.find((d) => d.status === 'error' || d.status === 'unconfirmed')
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
    return result
  }
}
