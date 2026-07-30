'use client'

export type ProductSummaryRow = {
  sku: string
  name: string
  ambassadors: number
  units: number
}

/**
 * How far each product has spread: how many ambassadors hold it, and how many
 * units went out. One row per real product, because the ledger keys on SKU and
 * not on a shop's own listing of it.
 */
export function ProductOverview({ rows }: { rows: ProductSummaryRow[] }) {
  return (
    <section className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Products with ambassadors</h2>
        <p className="text-[12px] text-muted">{rows.length} products</p>
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
                Nothing handed out yet. Open an ambassador’s Edit and add what they were sent.
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
