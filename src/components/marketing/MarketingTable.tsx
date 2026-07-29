'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { MarketingShopRow } from '@/lib/ads/marketing'

/**
 * Shop by shop: what the ads cost and what came back. Two ROAS numbers exist
 * on purpose and are labelled so they cannot be confused: P. ROAS is what the
 * platform attributes (matches Ads Manager), Store ROAS is the whole store's
 * gross revenue against spend (matches the dashboard). A dash is a ratio with
 * nothing to divide by, never a zero pretending.
 */

type Column = {
  key: keyof MarketingShopRow
  label: string
  hint?: string
  kind: 'money' | 'roas' | 'pct' | 'count' | 'decimal'
}

const COLUMNS: Column[] = [
  { key: 'spend', label: 'Ad spend', kind: 'money', hint: 'Meta and Google combined' },
  { key: 'dailyBudget', label: 'Daily budget', kind: 'money', hint: 'Current daily budgets across active campaigns, as set on the platforms' },
  { key: 'conversions', label: 'Purchases', kind: 'decimal', hint: 'Purchases as the platforms attribute them' },
  { key: 'conversionValue', label: 'Conv. value', kind: 'money', hint: 'Purchase value as the platforms attribute it' },
  { key: 'platformRoas', label: 'P. ROAS', kind: 'roas', hint: 'Purchase ROAS as the platform reports it: attributed value divided by spend' },
  { key: 'costPerPurchase', label: 'Cost/purchase', kind: 'money', hint: 'Spend per attributed purchase (cost per result)' },
  { key: 'roas', label: 'Store ROAS', kind: 'roas', hint: 'Whole-store gross revenue divided by ad spend' },
  { key: 'grossRevenue', label: 'Gross revenue', kind: 'money', hint: 'What customers actually paid: net revenue + VAT' },
  { key: 'orders', label: 'Orders', kind: 'count', hint: 'Paid orders in the store, all channels' },
  { key: 'cpa', label: 'CPA', kind: 'money', hint: 'Ad spend per paid store order' },
  { key: 'metaSpend', label: 'Meta', kind: 'money' },
  { key: 'googleSpend', label: 'Google', kind: 'money' },
  { key: 'avgPurchaseValue', label: 'Avg purchase', kind: 'money', hint: 'Attributed value per purchase' },
  { key: 'cpm', label: 'CPM', kind: 'money', hint: 'Cost per 1,000 impressions' },
  { key: 'costPerLinkClick', label: 'Cost/link click', kind: 'money' },
  { key: 'linkCtr', label: 'Link CTR', kind: 'pct', hint: 'Link clicks per impression' },
  { key: 'cpc', label: 'Avg. CPC', kind: 'money', hint: 'Spend per click, all clicks' },
  { key: 'ctr', label: 'CTR', kind: 'pct', hint: 'All clicks per impression' },
  { key: 'holdRate', label: 'Hold rate', kind: 'pct', hint: 'ThruPlays (15 s or complete) per 3-second play' },
  { key: 'videoViews3s', label: '3s plays', kind: 'count' },
  { key: 'thruplays', label: 'ThruPlays', kind: 'count' },
  { key: 'clicks', label: 'Clicks', kind: 'count' },
]

/**
 * The everyday view — the client's own Google list (budget, spend, purchases,
 * value, ROAS, Avg. CPC, clicks) plus the store context; everything else is
 * one tick away in Select metrics.
 */
const DEFAULT_HIDDEN = [
  'metaSpend',
  'googleSpend',
  'avgPurchaseValue',
  'cpm',
  'costPerLinkClick',
  'linkCtr',
  'ctr',
  'holdRate',
  'videoViews3s',
  'thruplays',
]

const STORAGE_KEY = 'marketing-columns'

function useVisibleColumns() {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set(DEFAULT_HIDDEN)
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return new Set(DEFAULT_HIDDEN)
      const allKeys = COLUMNS.map((c) => c.key as string)
      const saved = JSON.parse(raw) as string[]
      return new Set(saved.filter((k) => allKeys.includes(k)))
    } catch {
      return new Set(DEFAULT_HIDDEN)
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

function cellText(column: Column, value: number | null, currency: string): string {
  if (value === null) return '—'
  switch (column.kind) {
    case 'money':
      return formatMoney(value, currency)
    case 'roas':
      return `${value.toFixed(2)}×`
    case 'pct':
      return `${(value * 100).toFixed(1)}%`
    case 'decimal':
      return value % 1 === 0 ? value.toLocaleString('en-US') : value.toFixed(1)
    case 'count':
      return Math.round(value).toLocaleString('en-US')
  }
}

const stripeOf = (index: number) => (index % 2 === 1 ? 'bg-panel/45' : '')

export function MarketingTable({
  rows,
  total,
  currency,
}: {
  rows: MarketingShopRow[]
  total: MarketingShopRow
  currency: string
}) {
  const [sortBy, setSortBy] = useState<keyof MarketingShopRow>('spend')
  const [desc, setDesc] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const { columns, hidden, toggle } = useVisibleColumns()

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortBy] ?? Number.NEGATIVE_INFINITY
    const bv = b[sortBy] ?? Number.NEGATIVE_INFINITY
    if (av === bv) return a.shopName.localeCompare(b.shopName)
    if (typeof av === 'string' || typeof bv === 'string')
      return desc ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
    return desc ? Number(bv) - Number(av) : Number(av) - Number(bv)
  })

  const onSort = (key: keyof MarketingShopRow) => {
    if (key === sortBy) setDesc(!desc)
    else {
      setSortBy(key)
      setDesc(true)
    }
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Ads by shop</h2>
        <div className="flex items-center gap-3">
          <p className="text-[12px] text-muted">shown in {currency}</p>
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
                      onClick={() => onSort(column.key)}
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
            {sorted.map((row) => (
              <tr
                key={row.shopId}
                className="border-b border-line bg-surface transition-colors duration-150 last:border-b-0 hover:bg-panel"
              >
                <td className="sticky left-0 z-10 bg-inherit px-5 py-2.5 font-medium text-ink">
                  {row.shopName}
                </td>
                {columns.map((column, i) => (
                  <td key={column.key} className={`num px-4 py-2.5 text-right text-ink ${stripeOf(i)}`}>
                    {cellText(column, row[column.key] as number | null, currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="border-t border-line bg-panel font-semibold">
              <td className="sticky left-0 z-10 bg-inherit px-5 py-3 text-ink">Total</td>
              {columns.map((column, i) => (
                <td key={column.key} className={`num px-4 py-3 text-right text-ink ${stripeOf(i)}`}>
                  {cellText(column, total[column.key] as number | null, currency)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
