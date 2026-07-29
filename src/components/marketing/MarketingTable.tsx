'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { MarketingShopRow } from '@/lib/ads/marketing'

/**
 * Shop by shop: what the ads cost and what came back. Sorted by spend, because
 * the money at stake is the first question. A dash is a ratio with nothing to
 * divide by, never a zero pretending.
 */

type Column = {
  key: keyof MarketingShopRow
  label: string
  hint?: string
  kind: 'money' | 'roas' | 'ctr' | 'count'
}

const COLUMNS: Column[] = [
  { key: 'spend', label: 'Ad spend', kind: 'money', hint: 'Meta and Google combined' },
  { key: 'metaSpend', label: 'Meta', kind: 'money' },
  { key: 'googleSpend', label: 'Google', kind: 'money' },
  { key: 'grossRevenue', label: 'Gross revenue', kind: 'money', hint: 'What customers actually paid: net revenue + VAT' },
  { key: 'roas', label: 'ROAS', kind: 'roas', hint: 'Gross revenue divided by ad spend' },
  { key: 'cpa', label: 'CPA', kind: 'money', hint: 'Ad spend per paid order' },
  { key: 'orders', label: 'Orders', kind: 'count' },
  { key: 'cpc', label: 'CPC', kind: 'money', hint: 'Ad spend per click' },
  { key: 'ctr', label: 'CTR', kind: 'ctr', hint: 'Clicks per impression' },
  { key: 'clicks', label: 'Clicks', kind: 'count' },
]

function cellText(column: Column, value: number | null, currency: string): string {
  if (value === null) return '—'
  switch (column.kind) {
    case 'money':
      return formatMoney(value, currency)
    case 'roas':
      return `${value.toFixed(2)}×`
    case 'ctr':
      return `${(value * 100).toFixed(1)}%`
    case 'count':
      return value.toLocaleString('en-US')
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

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortBy] ?? Number.NEGATIVE_INFINITY
    const bv = b[sortBy] ?? Number.NEGATIVE_INFINITY
    if (av === bv) return a.shopName.localeCompare(b.shopName)
    if (typeof av === 'string' || typeof bv === 'string')
      return desc
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv))
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
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-panel text-left text-muted">
              <th className="sticky left-0 z-10 bg-panel px-3 py-2.5 font-medium">
                <button
                  onClick={() => onSort('shopName')}
                  className="hover:text-ink"
                  aria-sort={sortBy === 'shopName' ? (desc ? 'descending' : 'ascending') : undefined}
                >
                  Shop{sortBy === 'shopName' ? (desc ? ' ↓' : ' ↑') : ''}
                </button>
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-3 py-2.5 text-right font-medium">
                  <button
                    onClick={() => onSort(c.key)}
                    title={c.hint}
                    className="hover:text-ink"
                    aria-sort={sortBy === c.key ? (desc ? 'descending' : 'ascending') : undefined}
                  >
                    {c.label}
                    {sortBy === c.key ? (desc ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-ink">
            {sorted.map((row, index) => (
              <tr key={row.shopId} className={`border-t border-line ${stripeOf(index)}`}>
                <td
                  className={`sticky left-0 z-10 px-3 py-2.5 font-medium ${
                    stripeOf(index) || 'bg-surface'
                  }`}
                >
                  {row.shopName}
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="num px-3 py-2.5 text-right">
                    {cellText(c, row[c.key] as number | null, currency)}
                  </td>
                ))}
              </tr>
            ))}

            <tr className="border-t border-line bg-panel/60 font-semibold">
              <td className="sticky left-0 z-10 bg-panel px-3 py-2.5">Total</td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="num px-3 py-2.5 text-right">
                  {cellText(c, total[c.key] as number | null, currency)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}
