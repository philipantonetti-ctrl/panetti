'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney } from '@/lib/money'
import type { Shop } from '@/components/filters/ShopFilter'
import type { CategoryGroup } from '@/lib/expense-categories'
import {
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABEL,
  statusOf,
  type ExpenseStatus,
} from '@/lib/expense-status'
import { recurrenceDetail, finalPayment, formatDay } from '@/lib/expense-format'
import { SearchableSelect, type SelectOption } from '@/components/SearchableSelect'
import { allCurrencies, isConvertible } from '@/lib/currencies'

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

/** Every currency, once — the list never changes. */
const CURRENCY_OPTIONS: SelectOption[] = allCurrencies().map((c) => ({
  value: c.code,
  label: c.label, // "USD - $"
}))

const STATUS_TONE: Record<ExpenseStatus, string> = {
  ACTIVE: 'bg-panel text-gain',
  ENDED: 'bg-panel text-muted',
  ACTIVE_WITH_END_DATE: 'bg-warn-soft text-warn',
}

/** The person icon: this expense was entered by hand, not synced from a platform. */
function SourceIcon() {
  return (
    <span title="Added by hand" className="text-faint">
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
    <AppShell email={email}>
      <PageHeader
        title="Operational Expenses"
        subtitle="Recurring costs are spread across the days of the period you view, so profit is right for any date range."
      >
        <select
          value={shopId}
          aria-label="Shop"
          onChange={(e) => setShopId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
          ))}
        </select>

        <select
          value={statusFilter}
          aria-label="Status"
          onChange={(e) => setStatusFilter(e.target.value as 'ALL' | ExpenseStatus)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          <option value="ALL">Status: all</option>
          {EXPENSE_STATUSES.map((s) => (
            <option key={s} value={s}>{EXPENSE_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </PageHeader>

      <PageBody>
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
            <div className="text-sm text-ink">
              <span className="text-lg font-bold text-ink">{filtered.length}</span> Operational
              Expenses
            </div>

            <div className="flex items-center gap-2">
              {selected.length > 0 && (
                <button
                  onClick={() => remove(selected)}
                  className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-loss hover:bg-warn-soft"
                >
                  Delete {selected.length}
                </button>
              )}
              <button
                onClick={() => setAdding(true)}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                + Add expense
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line py-3 text-xs text-muted">
            <label className="flex items-center gap-2">
              Per page
              <select
                value={perPage}
                aria-label="Per page"
                onChange={(e) => setPerPage(Number(e.target.value))}
                className="rounded-[var(--radius-control)] border border-line bg-surface px-2 py-1.5 text-ink"
              >
                {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              aria-label="Search"
              className="w-56 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-ink placeholder:text-faint"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allShownSelected}
                      onChange={(e) =>
                        setSelected(e.target.checked ? shown.map((x) => x.id) : [])
                      }
                      className="accent-[var(--color-accent)]"
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
              <tbody className="text-ink">
                {loading ? (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-faint">Loading…</td></tr>
                ) : shown.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-faint">No expenses.</td></tr>
                ) : (
                  shown.map((e) => {
                    const status = statusOf({ endDate: e.endDate ? new Date(e.endDate) : null })
                    return (
                      <tr key={e.id} className="border-t border-line align-top">
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
                            className="accent-[var(--color-accent)]"
                          />
                        </td>

                        <td className="px-3 py-3">
                          <div className="font-semibold text-ink">{e.label}</div>
                          {/* The category sits under the name, as in the finance tools. */}
                          <div className="text-[11px] text-faint">{e.category.split(' > ').pop()}</div>
                        </td>

                        <td className="px-3 py-3 text-muted">Expense</td>

                        <td className="px-3 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]}`}>
                            {EXPENSE_STATUS_LABEL[status]}
                          </span>
                        </td>

                        <td className="px-3 py-3"><SourceIcon /></td>

                        <td className="px-3 py-3 text-right font-medium text-ink">
                          {formatMoney(e.amount, e.currency)}
                        </td>

                        <td className="px-3 py-3">
                          <div className="text-ink">{RECURRENCE_LABEL[e.recurrence] ?? e.recurrence}</div>
                          <div className="text-[11px] text-faint">
                            ({recurrenceDetail(e.recurrence, new Date(e.startDate))})
                          </div>
                        </td>

                        <td className="px-3 py-3 text-muted">
                          {finalPayment(e.endDate ? new Date(e.endDate) : null)}
                        </td>

                        <td className="px-3 py-3">
                          <span
                            title={`Added ${formatDay(new Date(e.createdAt))}`}
                            className="cursor-help text-accent"
                          >
                            🕘
                          </span>
                        </td>

                        <td className="relative px-3 py-3 text-right">
                          <button
                            aria-label={`Actions for ${e.label}`}
                            onClick={() => setMenuFor(menuFor === e.id ? null : e.id)}
                            className="rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                          >
                            ⋯
                          </button>
                          {menuFor === e.id && (
                            <div className="absolute right-3 z-10 mt-1 w-32 rounded-[var(--radius-control)] border border-line bg-surface py-1 shadow-lg">
                              <button
                                onClick={() => remove([e.id])}
                                className="block w-full px-3 py-2 text-left text-xs text-loss hover:bg-warn-soft"
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
            <div className="flex items-center justify-end gap-2 border-t border-line pt-3 text-xs">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded border border-line px-2 py-1 text-muted disabled:opacity-40"
              >
                ‹
              </button>
              <span className="text-muted">Page {page} of {pages}</span>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page === pages}
                className="rounded border border-line px-2 py-1 text-muted disabled:opacity-40"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </PageBody>

      {adding && shop && (
        <ExpenseModal
          shop={shop}
          categoryGroups={categoryGroups}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
          onAdded={load}
        />
      )}
    </AppShell>
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
  // Flatten the category tree into searchable options, keeping the group headings.
  const categoryOptions: SelectOption[] = categoryGroups.flatMap((g) =>
    g.options.map((option) => ({
      value: `${g.group} > ${option}`,
      label: option,
      group: g.group,
    })),
  )

  const [label, setLabel] = useState('')
  // No default: an expense must never be filed under a category nobody chose.
  const [category, setCategory] = useState('')
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-[var(--radius-card)] bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">Add operational expense</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="recurrence" className="block text-xs font-medium text-ink">Recurrence</label>
            <select id="recurrence" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink">
              {RECURRENCES.map((r) => <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="status" className="block text-xs font-medium text-ink">Expense Status</label>
            <select id="status" value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink">
              {EXPENSE_STATUSES.map((s) => (
                <option key={s} value={s}>{EXPENSE_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>

          {status !== 'ACTIVE' && (
            <div className="col-span-2">
              <label htmlFor="endDate" className="block text-xs font-medium text-ink">
                {status === 'ENDED' ? 'Final payment' : 'End date'}
              </label>
              <p className="text-[11px] text-muted">
                {status === 'ENDED'
                  ? 'The expense stops here. The months it ran still count.'
                  : 'The expense keeps running until this date.'}
              </p>
              <input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink" />
            </div>
          )}

          <div>
            <label htmlFor="category" className="block text-xs font-medium text-ink">Category</label>
            {/* Searchable, and grouped: Overhead, Financing, Marketing, Operations,
                Fulfillment, Other, Transaction fees. */}
            <div className="mt-1">
              <SearchableSelect
                id="category"
                ariaLabel="Category"
                value={category}
                onChange={setCategory}
                options={categoryOptions}
              />
            </div>
          </div>

          <div className="col-span-2">
            <label htmlFor="label" className="block text-xs font-medium text-ink">Expense Label</label>
            <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="E.g. subscriptions, payroll"
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint" />
          </div>

          <div className="col-span-2">
            <label htmlFor="metric" className="block text-xs font-medium text-ink">Metric Allocation</label>
            {/* Locked, as in BeProfit — everything on this screen is an operational expense. */}
            <input id="metric" value="Operational Expenses" disabled readOnly
              className="mt-1 w-full cursor-not-allowed rounded-[var(--radius-control)] border border-line bg-panel px-3 py-2 text-sm text-muted" />
          </div>

          <div className="col-span-2">
            <label htmlFor="amount" className="block text-xs font-medium text-ink">Expense Amount</label>
            <div className="mt-1 flex items-start gap-2">
              <div className="w-40 shrink-0">
                <SearchableSelect
                  ariaLabel="Currency"
                  value={currency}
                  onChange={setCurrency}
                  options={CURRENCY_OPTIONS}
                />
              </div>
              <input id="amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="Enter amount here"
                className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint" />
            </div>

            {/* Be honest: we only hold exchange rates for the ECB's list. Without one we
                cannot fold this expense into the USD totals correctly. */}
            {!isConvertible(currency) && (
              <p className="mt-1.5 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn">
                ⚠️ We have no exchange rate for <strong>{currency}</strong>, so this expense cannot be
                converted for the multi-shop USD totals. It will still be exact on {shop.name}&apos;s own
                figures.
              </p>
            )}
          </div>

          <div className="col-span-2">
            <label htmlFor="firstPayment" className="block text-xs font-medium text-ink">First payment</label>
            <p className="text-[11px] text-muted">1st time you paid for this expense</p>
            <input id="firstPayment" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink" />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-ink hover:text-ink">Cancel</button>
          <button onClick={() => save(true)} disabled={busy || !label || !category}
            className="rounded-[var(--radius-control)] border border-line px-4 py-2 text-xs font-semibold text-ink hover:bg-panel disabled:opacity-60">
            Save and add another
          </button>
          <button onClick={() => save(false)} disabled={busy || !label || !category}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save and close'}
          </button>
        </div>
      </div>
    </div>
  )
}
