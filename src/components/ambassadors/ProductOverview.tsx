'use client'

import Link from 'next/link'

export type ProductSummaryRow = {
  sku: string
  name: string
  ambassadors: number
  units: number
}

/**
 * Which products have gone out to ambassadors: how many hold each, and how
 * many units went out. One row per real product, because the ledger keys on
 * SKU and not on a shop's own listing of it.
 *
 * It sits under Top ambassadors, whose Shops and Period filters do not reach
 * it: this counts every product ever handed out. The label says so, where the
 * eye compares the two tables. Products are handed out on the other tab, in
 * an ambassador's Edit, so the empty state carries the way there.
 */
export function ProductOverview({ rows }: { rows: ProductSummaryRow[] }) {
  return (
    <section className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Products with ambassadors</h2>
        <p className="text-[12px] text-muted">
          {rows.length} {rows.length === 1 ? 'product' : 'products'}, all shops, all time
        </p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-y border-line bg-panel text-left text-muted">
            <th className="px-3 py-2.5 font-medium">Product</th>
            <th className="px-3 py-2.5 font-medium">SKU</th>
            <th className="px-3 py-2.5 text-right font-medium">Ambassadors</th>
            <th className="px-3 py-2.5 text-right font-medium">Units</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-faint">
                Nothing handed out yet. Open{' '}
                <Link href="/ambassadors/add" className="text-accent hover:underline">
                  Add an ambassador
                </Link>
                , press Edit on the ambassador and add what they were sent.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.sku} data-testid="product-overview-row" className="border-t border-line">
                <td className="px-3 py-2.5 font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2.5 text-muted">{r.sku}</td>
                <td className="num px-3 py-2.5 text-right">{r.ambassadors}</td>
                <td className="num px-3 py-2.5 text-right">{r.units}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  )
}
