'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { EngineResult, ShopFigures } from '@/lib/metrics/types'

/**
 * Every shop, side by side.
 *
 * Numbers are right-aligned and tabular so columns line up digit for digit — the whole
 * point of the table is comparing them at a glance. A loss is red AND signed, so the
 * meaning survives colour-blindness and a black-and-white printout.
 */

type Column = {
  key: keyof ShopFigures
  label: string
  hint?: string
  money?: boolean
  percent?: boolean
  tone?: boolean // colour by sign
}

const COLUMNS: Column[] = [
  { key: 'orders', label: 'Orders' },
  { key: 'grossSales', label: 'Gross sales', money: true, hint: 'Before discounts, excl. VAT (Shopify sense — not "brutto")' },
  { key: 'discounts', label: 'Discounts', money: true, hint: 'Coupon and code discounts, excl. VAT' },
  { key: 'netSales', label: 'Net sales', money: true, hint: 'After discounts — the commission base, excl. VAT' },
  { key: 'shippingCharged', label: 'Shipping', money: true, hint: 'Shipping charged to customers, excl. VAT' },
  { key: 'taxes', label: 'VAT', money: true, hint: 'VAT collected (25% NO/SE/DK, 25.5% FI, 19% DE) — remitted to the tax office, never income or cost' },
  { key: 'salesInclVat', label: 'Sales incl. VAT', money: true, hint: 'What customers actually paid: net revenue + VAT (Nordic "brutto")' },
  { key: 'netRevenue', label: 'Net revenue', money: true, hint: 'Net sales + shipping, excl. VAT — the basis for profit' },
  { key: 'transactionFees', label: 'Transaction fees', money: true, hint: 'Payment gateway: % of the charged total + fixed part' },
  { key: 'cogs', label: 'COGS', money: true, hint: 'Product cost + handling' },
  { key: 'fulfillment', label: 'Fulfillment', money: true, hint: 'Per-order rate from Settings' },
  { key: 'operationalExpenses', label: 'Op. expenses', money: true },
  { key: 'commission', label: 'Commission', money: true },
  { key: 'netProfit', label: 'Net profit', money: true, tone: true },
  { key: 'netMargin', label: 'Margin', percent: true, tone: true },
]

const STORAGE_KEY = 'compare-columns'

/** Which metric columns to show. Everything on by default; the choice is remembered per browser. */
function useVisibleColumns() {
  // Read the saved choice lazily. This table only ever mounts on the client (the
  // dashboard shows a skeleton until its data arrives), so localStorage is safe
  // here — and doing it in the initializer keeps setState out of an effect.
  // Unknown keys are dropped, so a renamed metric can never wedge the table.
  const [hidden, setHidden] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return new Set()
      const allKeys = COLUMNS.map((c) => c.key as string)
      const saved = JSON.parse(raw) as string[]
      return new Set(saved.filter((k) => allKeys.includes(k)))
    } catch {
      return new Set()
    }
  })

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Non-fatal: the table still reflects the choice for this session.
      }
      return next
    })
  }

  return { columns: COLUMNS.filter((c) => !hidden.has(c.key)), hidden, toggle }
}

/** BeProfit-style vertical banding: every other metric column is lightly tinted. */
const stripeOf = (index: number) => (index % 2 === 1 ? 'bg-panel/45' : '')

function Cell({
  column,
  row,
  currency,
  stripe,
}: {
  column: Column
  row: ShopFigures
  currency: string
  stripe: string
}) {
  const value = row[column.key] as number

  const text = column.money
    ? formatMoney(value, currency)
    : column.percent
      ? `${(value * 100).toFixed(1)}%`
      : value.toLocaleString('en-US')

  const tone = !column.tone ? 'text-ink' : value < 0 ? 'text-loss' : 'text-gain'
  const weight = column.key === 'netProfit' ? 'font-semibold' : ''

  return <td className={`num px-4 py-2.5 text-right ${tone} ${weight} ${stripe}`}>{text}</td>
}

export function CompareTable({ result }: { result: EngineResult }) {
  const [sortBy, setSortBy] = useState<keyof ShopFigures>('netProfit')
  const [desc, setDesc] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const { columns, hidden, toggle } = useVisibleColumns()

  const currency = result.displayCurrency

  const rows = [...result.byShop].sort((a, b) => {
    const x = a[sortBy] as number
    const y = b[sortBy] as number
    return desc ? y - x : x - y
  })

  function sort(key: keyof ShopFigures) {
    if (key === sortBy) setDesc((d) => !d)
    else {
      setSortBy(key)
      setDesc(true)
    }
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Compare shops</h2>
        <div className="flex items-center gap-3">
          <p className="text-[12px] text-muted">
            {result.byShop.length} shops · shown in {currency}
          </p>
          <div className="relative">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
              className="rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink transition-colors duration-150 hover:border-faint"
            >
              Select metrics
            </button>
            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setPickerOpen(false)} />
                <div className="absolute right-0 z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-[var(--radius-control)] border border-line bg-surface p-1.5 shadow-lg">
                  <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold text-faint">Show metrics</p>
                  {COLUMNS.map((c) => (
                    <label
                      key={c.key}
                      className="flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-[12px] text-ink hover:bg-panel"
                    >
                      <input
                        type="checkbox"
                        aria-label={c.label}
                        checked={!hidden.has(c.key)}
                        onChange={() => toggle(c.key)}
                        className="h-3.5 w-3.5"
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-y border-line bg-panel">
              <th className="sticky left-0 z-10 bg-panel px-5 py-2 text-left text-[11px] font-semibold text-faint">
                Shop
              </th>

              {columns.map((column, i) => {
                const active = sortBy === column.key
                return (
                  <th
                    key={column.key}
                    className={`px-4 py-2 text-right ${stripeOf(i)}`}
                    title={column.hint}
                    aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                  >
                    <button
                      onClick={() => sort(column.key)}
                      aria-label={`Sort by ${column.label}`}
                      className={`inline-flex items-center gap-1 text-[11px] font-semibold transition-colors duration-150 hover:text-ink ${
                        active ? 'text-ink' : 'text-faint'
                      }`}
                    >
                      {column.label}
                      <span aria-hidden="true" className={active ? 'text-accent' : 'opacity-0'}>
                        {desc ? '↓' : '↑'}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr
                key={row.shopId}
                className="border-b border-line bg-surface transition-colors duration-150 last:border-b-0 hover:bg-panel"
              >
                <td className="sticky left-0 z-10 bg-inherit px-5 py-2.5 font-medium text-ink">{row.shopName}</td>
                {columns.map((column, i) => (
                  <Cell key={column.key} column={column} row={row} currency={currency} stripe={stripeOf(i)} />
                ))}
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="border-t border-line bg-panel font-semibold">
              <td className="sticky left-0 z-10 bg-inherit px-5 py-3 text-ink">Total</td>
              {columns.map((column, i) => (
                <Cell
                  key={column.key}
                  column={column}
                  row={{ ...result.total, shopId: 'total', shopName: 'Total' }}
                  currency={currency}
                  stripe={stripeOf(i)}
                />
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
