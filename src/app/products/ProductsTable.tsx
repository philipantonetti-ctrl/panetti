'use client'

import { Fragment, useState } from 'react'
import { formatMoney } from '@/lib/money'
import { Thumb } from '@/components/Thumb'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

/**
 * One product per row, merged across stores, expanding into the stores that
 * make it up. Every figure is exact: nothing on this page is apportioned, so
 * no column here can disagree with an order the client opens to check it.
 */

/**
 * A margin with nothing to divide by is unknown, never 0.0%. Same convention
 * as `ratios()` in marketing.ts and the dash in BreakdownTable.
 */
function marginText(netSales: number, margin: number): string {
  if (netSales === 0) return '—'
  return `${(margin * 100).toFixed(1)}%`
}

function countText(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * `costOn` returns zero when no cost was ever entered, which makes an uncosted
 * product report a 100% margin — a lie that looks like a triumph. Every such
 * row says so.
 */
function CostWarning() {
  return (
    <span title="This product has no cost entered, so its margin is not real." className="ml-1.5 text-loss">
      ⚠
    </span>
  )
}

export function ProductsTable({
  rows,
  total,
  currency,
}: {
  rows: ProductRow[]
  total: ProductTotals
  currency: string
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())

  function toggle(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (rows.length === 0) {
    return (
      <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        <p className="px-5 py-8 text-center text-[13px] text-muted">No products sold in this period.</p>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
              <th className="px-4 py-2">Product</th>
              <th className="px-4 py-2 text-right">Orders</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Gross</th>
              <th className="px-4 py-2 text-right">Revenue</th>
              <th className="px-4 py-2 text-right">COGS</th>
              <th className="px-4 py-2 text-right">Profit</th>
              <th className="px-4 py-2 text-right">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = openKeys.has(row.key)
              // One store is not a breakdown — there is nothing to reveal.
              const expandable = row.stores.length > 1

              return (
                <Fragment key={row.key}>
                  <tr
                    className={`border-b border-line ${expandable ? 'cursor-pointer hover:bg-panel' : ''}`}
                    onClick={expandable ? () => toggle(row.key) : undefined}
                  >
                    <td className="py-2 pl-4 pr-4">
                      <div className="flex items-center gap-2.5">
                        <Thumb src={row.imageUrl} alt={row.name} />
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggle(row.key)
                            }}
                            className="flex items-center gap-1.5 text-left text-[13px] font-medium text-ink"
                          >
                            <span
                              aria-hidden="true"
                              className={`inline-block w-3 text-faint transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                            >
                              ›
                            </span>
                            {row.name}
                          </button>
                        ) : (
                          // pl-[18px] keeps an unexpandable name aligned with the
                          // expandable ones, whose chevron occupies that space.
                          <span className="block pl-[18px] text-[13px] text-ink">{row.name}</span>
                        )}
                        {!row.hasCost && <CostWarning />}
                      </div>
                    </td>
                    <td className="num px-4 py-2 text-right text-ink">{countText(row.orders)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{countText(row.quantity)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.grossSales, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.netSales, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.cogs, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{formatMoney(row.profit, currency)}</td>
                    <td className="num px-4 py-2 text-right text-ink">{marginText(row.netSales, row.margin)}</td>
                  </tr>

                  {expandable &&
                    isOpen &&
                    row.stores.map((s) => (
                      // productId, not shopId: that is the real uniqueness guarantee
                      // (products.ts buckets per-store figures by productId), and two
                      // Woo products in one shop can share a SKU.
                      <tr key={`${row.key}:${s.productId}`} className="border-b border-line bg-panel/40">
                        <td className="py-2 pl-10 pr-4 text-[12px] text-muted">
                          {s.shopName}
                          {!s.hasCost && <CostWarning />}
                        </td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{countText(s.orders)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{countText(s.quantity)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.grossSales, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.netSales, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.cogs, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{formatMoney(s.profit, currency)}</td>
                        <td className="num px-4 py-2 text-right text-[12px] text-muted">{marginText(s.netSales, s.margin)}</td>
                      </tr>
                    ))}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-panel text-[13px] font-semibold text-ink">
              <td className="px-4 py-2">Total</td>
              <td className="num px-4 py-2 text-right">{countText(total.orders)}</td>
              <td className="num px-4 py-2 text-right">{countText(total.quantity)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.grossSales, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.netSales, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.cogs, currency)}</td>
              <td className="num px-4 py-2 text-right">{formatMoney(total.profit, currency)}</td>
              <td className="num px-4 py-2 text-right">{marginText(total.netSales, total.margin)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
