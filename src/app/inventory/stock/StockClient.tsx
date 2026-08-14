'use client'

export type StockRow = {
  sku: string
  name: string
  quantity: number | null
  disagrees: boolean
  byShop: { shopName: string; quantity: number | null; updatedAt: string | null }[]
}

/**
 * What each shop says, side by side.
 *
 * Disagreements sort to the top, because a mirror that has drifted is invisible
 * on any single store — each one looks perfectly consistent with itself.
 */
export function StockClient({ rows }: { rows: StockRow[] }) {
  const sorted = [...rows].sort((a, b) => Number(b.disagrees) - Number(a.disagrees))

  if (sorted.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        No stock reported yet. Stock arrives with the next completed sync of each shop.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {sorted.map((r) => (
        <div key={r.sku} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink">
              {r.name} <span className="ml-1 font-normal text-faint">{r.sku}</span>
            </p>
            <p className="text-[13px] tabular-nums text-ink">
              {r.quantity ?? 'no stock data'}
              {r.disagrees && (
                <span className="ml-2 text-[11px] text-warn">
                  shops disagree
                </span>
              )}
            </p>
          </div>
          {r.disagrees && (
            <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
              {r.byShop.map((s) => (
                <li key={s.shopName}>
                  {s.shopName}: <span className="tabular-nums text-ink">{s.quantity ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
