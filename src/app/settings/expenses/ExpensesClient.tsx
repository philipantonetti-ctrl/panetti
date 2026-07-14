'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'
import type { CategoryGroup } from '@/lib/expense-categories'

type Expense = {
  id: string
  label: string
  category: string
  amount: number
  currency: string
  recurrence: string
  startDate: string
  active: boolean
}

const RECURRENCES = ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const RECURRENCE_LABEL: Record<string, string> = {
  ONE_TIME: 'One time', DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly',
}

export function ExpensesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([])
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)

  function load() {
    if (!shopId) return
    setLoading(true)
    fetch(`/api/expenses?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setExpenses(d.expenses ?? [])
        setCategoryGroups(d.categoryGroups ?? [])
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])

  const shop = shops.find((s) => s.id === shopId)

  async function remove(id: string) {
    await fetch(`/api/expenses/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-5xl p-5">
        <h1 className="text-lg font-bold text-slate-900">Operational expenses</h1>
        <p className="mt-1 text-sm text-slate-500">
          Recurring costs are spread across the days of the period you are viewing, so profit is right for
          any date range.
        </p>

        <div className="mt-4 flex items-center justify-between gap-3">
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
            ))}
          </select>

          <button
            onClick={() => setAdding(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            + Add expense
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2.5 font-medium">Expense</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 font-medium">Recurrence</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              ) : expenses.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-400">No expenses yet.</td></tr>
              ) : (
                expenses.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-3 py-2.5 font-medium text-slate-900">{e.label}</td>
                    <td className="px-3 py-2.5 text-slate-500">{e.category}</td>
                    <td className="px-3 py-2.5 text-right">{formatMoney(e.amount, e.currency)}</td>
                    <td className="px-3 py-2.5 text-slate-500">
                      {RECURRENCE_LABEL[e.recurrence] ?? e.recurrence}
                      {e.recurrence !== 'ONE_TIME' && <span className="text-slate-400"> (spread daily)</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        e.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {e.active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button onClick={() => remove(e.id)} className="text-slate-400 hover:text-red-600">Delete</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {adding && shop && (
        <ExpenseModal
          shop={shop}
          categoryGroups={categoryGroups}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }}
        />
      )}
    </div>
  )
}

function ExpenseModal({
  shop, categoryGroups, onClose, onSaved,
}: {
  shop: Shop
  categoryGroups: CategoryGroup[]
  onClose: () => void
  onSaved: () => void
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
  const [busy, setBusy] = useState(false)

  async function save() {
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
        active: true,
      }),
    })
    setBusy(false)
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
          <button onClick={save} disabled={busy || !label}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save and close'}
          </button>
        </div>
      </div>
    </div>
  )
}
