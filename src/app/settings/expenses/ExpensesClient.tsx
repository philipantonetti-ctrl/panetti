'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'
import type { CategoryGroup } from '@/lib/expense-categories'
import {
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABEL,
  statusOf,
  type ExpenseStatus,
} from '@/lib/expense-status'
import { recurrenceDetail, finalPayment, formatDay } from '@/lib/expense-format'

type Expense = {
  id: string
  label: string
  category: string
  amount: number
  currency: string
  recurrence: string
  startDate: string
  endDate: string | null
  active: boolean
  createdAt: string
}

const RECURRENCES = ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const RECURRENCE_LABEL: Record<string, string> = {
  ONE_TIME: 'One time', DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly',
}

const STATUS_TONE: Record<ExpenseStatus, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700',
  ENDED: 'bg-slate-100 text-slate-500',
  ACTIVE_WITH_END_DATE: 'bg-amber-50 text-amber-700',
}

/** The person icon: this expense was entered by hand, not synced from a platform. */
function SourceIcon() {
  return (
    <span title="Added by hand" className="text-slate-400">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    </span>
  )
}

export function ExpensesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([])
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)

  // Table controls
  const [statusFilter, setStatusFilter] = useState<'ALL' | ExpenseStatus>('ALL')
  const [search, setSearch] = useState('')
  const [perPage, setPerPage] = useState(10)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [menuFor, setMenuFor] = useState<string | null>(null)

  function load() {
    if (!shopId) return
    setLoading(true)
    fetch(`/api/expenses?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setExpenses(d.expenses ?? [])
        setCategoryGroups(d.categoryGroups ?? [])
        setSelected([])
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])
  useEffect(() => setPage(1), [statusFilter, search, perPage, shopId])

  const shop = shops.find((s) => s.id === shopId)

  async function remove(ids: string[]) {
    await Promise.all(ids.map((id) => fetch(`/api/expenses/${id}`, { method: 'DELETE' })))
    setMenuFor(null)
    load()
  }

  const filtered = expenses.filter((e) => {
    const status = statusOf({ endDate: e.endDate ? new Date(e.endDate) : null })
    if (statusFilter !== 'ALL' && status !== statusFilter) return false

    const q = search.trim().toLowerCase()
    if (!q) return true
    return e.label.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)
  })

  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)
  const allShownSelected = shown.length > 0 && shown.every((e) => selected.includes(e.id))

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-6xl p-5">
        <div className="flex items-center gap-3">
          <a
            href="/settings"
            aria-label="Back to settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-900"
          >
            ←
          </a>
          <h1 className="text-lg font-bold text-slate-900">Operational Expenses</h1>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
            ))}
          </select>

          <select
            value={statusFilter}
            aria-label="Status"
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | ExpenseStatus)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black"
          >
            <option value="ALL">Status: all</option>
            {EXPENSE_STATUSES.map((s) => (
              <option key={s} value={s}>{EXPENSE_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-slate-700">
              <span className="text-lg font-bold text-slate-900">{filtered.length}</span> Operational
              Expenses
            </div>

            <div className="flex items-center gap-2">
              {selected.length > 0 && (
                <button
                  onClick={() => remove(selected)}
                  className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  Delete {selected.length}
                </button>
              )}
              <button
                onClick={() => setAdding(true)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                + Add expense
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 py-3 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              Per page
              <select
                value={perPage}
                aria-label="Per page"
                onChange={(e) => setPerPage(Number(e.target.value))}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-black"
              >
                {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              aria-label="Search"
              className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-black placeholder:text-slate-400"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allShownSelected}
                      onChange={(e) =>
                        setSelected(e.target.checked ? shown.map((x) => x.id) : [])
                      }
                      className="accent-violet-700"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium">Expense</th>
                  <th className="px-3 py-2.5 font-medium">Type</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Source</th>
                  <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-3 py-2.5 font-medium">Recurrence</th>
                  <th className="px-3 py-2.5 font-medium">Final Payment</th>
                  <th className="px-3 py-2.5 font-medium">History</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {loading ? (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
                ) : shown.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No expenses.</td></tr>
                ) : (
                  shown.map((e) => {
                    const status = statusOf({ endDate: e.endDate ? new Date(e.endDate) : null })
                    return (
                      <tr key={e.id} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${e.label}`}
                            checked={selected.includes(e.id)}
                            onChange={(ev) =>
                              setSelected((prev) =>
                                ev.target.checked ? [...prev, e.id] : prev.filter((id) => id !== e.id),
                              )
                            }
                            className="accent-violet-700"
                          />
                        </td>

                        <td className="px-3 py-3">
                          <div className="font-semibold text-slate-900">{e.label}</div>
                          {/* The category sits under the name, as in the finance tools. */}
                          <div className="text-[11px] text-slate-400">{e.category.split(' > ').pop()}</div>
                        </td>

                        <td className="px-3 py-3 text-slate-600">Expense</td>

                        <td className="px-3 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]}`}>
                            {EXPENSE_STATUS_LABEL[status]}
                          </span>
                        </td>

                        <td className="px-3 py-3"><SourceIcon /></td>

                        <td className="px-3 py-3 text-right font-medium text-slate-900">
                          {formatMoney(e.amount, e.currency)}
                        </td>

                        <td className="px-3 py-3">
                          <div className="text-slate-700">{RECURRENCE_LABEL[e.recurrence] ?? e.recurrence}</div>
                          <div className="text-[11px] text-slate-400">
                            ({recurrenceDetail(e.recurrence, new Date(e.startDate))})
                          </div>
                        </td>

                        <td className="px-3 py-3 text-slate-600">
                          {finalPayment(e.endDate ? new Date(e.endDate) : null)}
                        </td>

                        <td className="px-3 py-3">
                          <span
                            title={`Added ${formatDay(new Date(e.createdAt))}`}
                            className="cursor-help text-violet-600"
                          >
                            🕘
                          </span>
                        </td>

                        <td className="relative px-3 py-3 text-right">
                          <button
                            aria-label={`Actions for ${e.label}`}
                            onClick={() => setMenuFor(menuFor === e.id ? null : e.id)}
                            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          >
                            ⋯
                          </button>
                          {menuFor === e.id && (
                            <div className="absolute right-3 z-10 mt-1 w-32 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                              <button
                                onClick={() => remove([e.id])}
                                className="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3 text-xs">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded border border-slate-200 px-2 py-1 text-slate-600 disabled:opacity-40"
              >
                ‹
              </button>
              <span className="text-slate-500">Page {page} of {pages}</span>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page === pages}
                className="rounded border border-slate-200 px-2 py-1 text-slate-600 disabled:opacity-40"
              >
                ›
              </button>
            </div>
          )}
        </div>

        <p className="mt-3 text-[11px] text-slate-400">
          &quot;Spread daily&quot; means a monthly cost is charged day by day, so profit is right for any
          date range you look at — not just whole months.
        </p>
      </main>

      {adding && shop && (
        <ExpenseModal
          shop={shop}
          categoryGroups={categoryGroups}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
          onAdded={load}
        />
      )}
    </div>
  )
}

function ExpenseModal({
  shop, categoryGroups, onClose, onSaved, onAdded,
}: {
  shop: Shop
  categoryGroups: CategoryGroup[]
  onClose: () => void
  onSaved: () => void
  onAdded: () => void // saved, but the modal stays open for the next one
}) {
  const first = categoryGroups[0]
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState(
    first ? `${first.group} > ${first.options[0]}` : 'Other > Other',
  )
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(shop.currency)
  const [recurrence, setRecurrence] = useState('MONTHLY')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [status, setStatus] = useState<ExpenseStatus>('ACTIVE')
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  async function save(andAddAnother = false) {
    setBusy(true)
    await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopId: shop.id,
        label,
        category,
        amount: parseFloat(amount) || 0,
        currency,
        recurrence,
        startDate,
        status,
        endDate: status === 'ACTIVE' ? null : endDate,
      }),
    })
    setBusy(false)

    if (andAddAnother) {
      // Keep the shop, currency and recurrence; clear what changes each time.
      setLabel('')
      setAmount('')
      onAdded()
      return
    }
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="border-b border-slate-100 pb-3 text-base font-bold text-slate-900">Add operational expense</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="recurrence" className="block text-xs font-medium text-slate-700">Recurrence</label>
            <select id="recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black">
              {RECURRENCES.map((r) => <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="status" className="block text-xs font-medium text-slate-700">Expense Status</label>
            <select id="status" value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black">
              {EXPENSE_STATUSES.map((s) => (
                <option key={s} value={s}>{EXPENSE_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>

          {status !== 'ACTIVE' && (
            <div className="col-span-2">
              <label htmlFor="endDate" className="block text-xs font-medium text-slate-700">
                {status === 'ENDED' ? 'Final payment' : 'End date'}
              </label>
              <p className="text-[11px] text-slate-500">
                {status === 'ENDED'
                  ? 'The expense stops here — the months it ran still count.'
                  : 'The expense keeps running until this date.'}
              </p>
              <input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black" />
            </div>
          )}

          <div>
            <label htmlFor="category" className="block text-xs font-medium text-slate-700">Category</label>
            {/* Grouped exactly like BeProfit: Overhead, Financing, Marketing, Operations,
                Fulfillment, Other, Transaction fees. */}
            <select id="category" value={category} onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black">
              {categoryGroups.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((option) => {
                    const value = `${g.group} > ${option}`
                    return <option key={value} value={value}>{option}</option>
                  })}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="col-span-2">
            <label htmlFor="label" className="block text-xs font-medium text-slate-700">Expense Label</label>
            <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="E.g. subscriptions, payroll"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black placeholder:text-slate-400" />
          </div>

          <div className="col-span-2">
            <label htmlFor="metric" className="block text-xs font-medium text-slate-700">Metric Allocation</label>
            {/* Locked, as in BeProfit — everything on this screen is an operational expense. */}
            <input id="metric" value="Operational Expenses" disabled readOnly
              className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500" />
          </div>

          <div className="col-span-2">
            <label htmlFor="amount" className="block text-xs font-medium text-slate-700">Expense Amount</label>
            <div className="mt-1 flex">
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency"
                className="rounded-l-lg border border-r-0 border-slate-300 bg-slate-50 px-2 py-2 text-sm text-black">
                {['NOK', 'SEK', 'DKK', 'EUR', 'USD'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input id="amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="Enter amount here"
                className="w-full rounded-r-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black placeholder:text-slate-400" />
            </div>
          </div>

          <div className="col-span-2">
            <label htmlFor="firstPayment" className="block text-xs font-medium text-slate-700">First payment</label>
            <p className="text-[11px] text-slate-500">1st time you paid for this expense</p>
            <input id="firstPayment" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-700 hover:text-black">Cancel</button>
          <button onClick={() => save(true)} disabled={busy || !label}
            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
            Save and add another
          </button>
          <button onClick={() => save(false)} disabled={busy || !label}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save and close'}
          </button>
        </div>
      </div>
    </div>
  )
}
