'use client'

import { day, money } from '@/lib/finance/format'

export type FinanceRow = {
  referenceNumber: string
  customerName: string
  /** "Invoice" or "CreditNote", as Visma spells it. */
  documentType: string
  documentDate: string
  /** Null when Visma reported none. Such a document is never overdue. */
  dueDate: string | null
  currency: string
  /** Minor units, in `currency`. */
  balance: number
}

const DAY_MS = 86_400_000

/**
 * How this row reads to someone deciding whether to chase it.
 *
 * Three states, not two. "No due date" is its own answer: Visma leaves the
 * field off some documents, and showing those as due today would invent an
 * overdue invoice out of a missing field.
 */
function state(r: FinanceRow, now: Date): { text: string; tone: string; over: number | null } {
  if (!r.dueDate) return { text: 'no due date', tone: 'text-muted', over: null }

  const due = new Date(r.dueDate)
  const over = Math.floor((now.getTime() - due.getTime()) / DAY_MS)
  if (over > 0) {
    return {
      text: `${over} ${over === 1 ? 'day' : 'days'} overdue`,
      // Loud only past a month. Everything here is late by definition, so
      // colouring all of it red would make the 1 294-day one look ordinary.
      tone: over > 30 ? 'text-loss font-semibold' : 'text-warn',
      over,
    }
  }
  return { text: `due ${day(due)}`, tone: 'text-muted', over: null }
}

/**
 * What is owed us, worst first.
 *
 * A snapshot of Visma's own ledger. Nothing is editable here on purpose: an
 * invoice is raised and a payment is booked in Visma, so a figure typed on this
 * side would be a second answer to a question that already has one.
 */
export function FinanceClient({ rows, now }: { rows: FinanceRow[]; now: string }) {
  const today = new Date(now)

  if (rows.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing is outstanding. Every invoice Visma is holding open has been paid.
      </p>
    )
  }

  // Overdue first and oldest of those first, then what is merely due, then the
  // undated. Sorted here rather than in SQL because "overdue" is a fact about
  // today, and the page knows what day it is.
  const sorted = [...rows].sort((a, b) => {
    const A = state(a, today).over
    const B = state(b, today).over
    if (A !== null && B !== null) return B - A
    if (A !== null) return -1
    if (B !== null) return 1
    return (a.dueDate ?? '\uffff').localeCompare(b.dueDate ?? '\uffff')
  })

  // Per currency, never one number: these span NOK, SEK, DKK and EUR, and one
  // sum across four currencies is arithmetic on four different things.
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.balance)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-[var(--radius-card)] border border-line bg-surface p-4">
        {[...totals]
          .sort((a, b) => b[1] - a[1])
          .map(([currency, total]) => (
            <div key={currency}>
              <p className="text-[11px] uppercase tracking-wide text-faint">outstanding</p>
              <p
                data-testid="finance-total"
                className="text-[15px] font-semibold tabular-nums text-ink"
              >
                {money(total, currency)}
              </p>
            </div>
          ))}
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2.5">Customer</th>
              <th className="px-4 py-2.5">Invoice</th>
              <th className="px-4 py-2.5">Invoiced</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const s = state(r, today)
              return (
                <tr key={r.referenceNumber} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 text-ink">
                    {r.customerName}
                    {r.documentType === 'CreditNote' && (
                      <span className="ml-2 text-[11px] text-muted">credit note</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.referenceNumber}</td>
                  <td className="px-4 py-2.5 text-muted">{day(new Date(r.documentDate))}</td>
                  <td className={`px-4 py-2.5 ${s.tone}`}>{s.text}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                    {money(r.balance, r.currency)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
