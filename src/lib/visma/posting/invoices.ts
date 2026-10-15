/**
 * The two reads posting needs. Both re-check in code what the query asked
 * for: an unknown or ignored filter answers 200 with the wrong rows, and a
 * payment applied to the wrong invoice is worse than none.
 */

import { vismaGet, type VismaCredentials, type VismaRequestOpts } from '../client'
import { unwrap } from '../purchase-orders'
import type { OpenInvoice } from './plan'

type Row = Record<string, unknown>
const PAGE = 100
// Hitting the cap can only make an order "no open invoice" (skipped for the bookkeeper), never a wrong payment.
const MAX_PAGES = 20
const str = (v: unknown): string => String(unwrap<string | number>(v) ?? '').trim()
const num = (v: unknown): number => {
  const raw = unwrap<unknown>(v)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}
const enc = encodeURIComponent

export async function readOpenInvoices(
  creds: VismaCredentials,
  customer: string,
  opts: VismaRequestOpts = {},
): Promise<{ invoices: OpenInvoice[]; calls: number }> {
  const invoices: OpenInvoice[] = []
  // Every invoice number seen so far, kept or not. A page that repeats the last one
  // (Visma ignoring pageNumber) must neither duplicate rows nor count as another page.
  const seen = new Set<string>()
  let calls = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    calls++
    const rows = await vismaGet<Row[]>(
      creds,
      `controller/api/v1/customerinvoice?customer=${enc(customer)}&status=Open&pageSize=${PAGE}&pageNumber=${page}`,
      opts,
    )
    const list = Array.isArray(rows) ? rows : []
    let fresh = 0
    for (const r of list) {
      const number = str(r.referenceNumber)
      if (!number || seen.has(number)) continue
      seen.add(number)
      fresh++
      if (str(r.status) !== 'Open') continue
      if (str((r.customer as Row | undefined)?.number) !== customer) continue
      invoices.push({
        number,
        customerRefNumber: str(r.customerRefNumber),
        currency: str(r.currencyId),
        balance: Math.round(num(r.balanceInCurrency) * 100),
      })
    }
    if (fresh === 0 || list.length < PAGE) break
  }
  return { invoices, calls }
}

/** Our payment for this invoice, if Visma already holds one: its number, else null. */
export async function findOurPayment(
  creds: VismaCredentials,
  customer: string,
  invoiceNumber: string,
  reference: string,
  opts: VismaRequestOpts = {},
): Promise<string | null> {
  // Nothing to match on: answer without asking Visma, rather than matching a blank paymentRef.
  if (!reference.trim()) return null
  const rows = await vismaGet<Row[]>(
    creds,
    `controller/api/v1/customerPayment?customer=${enc(customer)}&invoiceRefNbr=${enc(invoiceNumber)}`,
    opts,
  )
  const hit = (Array.isArray(rows) ? rows : []).find((r) => str(r.paymentRef) === reference)
  return hit ? str(hit.refNbr) || null : null
}
