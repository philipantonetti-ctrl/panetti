'use client'

export type Row = {
  sku: string
  name: string
  supplierName: string | null
  stock: { quantity: number | null; disagrees: boolean; byShop: unknown[] }
  burn: number
  seasonal: boolean
  forecast: {
    runsOutOn: string | null
    orderBy: string | null
    daysLate: number | null
    quantity: number | null
    onOrderWithoutEta: number
    note: string | null
  }
  byCountry: { country: string; units: number }[]
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

export function InventoryClient({ rows, unusable }: { rows: Row[]; unusable: { shopName: string; name: string; sku: string }[] }) {
  if (rows.length === 0 && unusable.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing to forecast yet. Set a supplier and lead times under{' '}
        <span className="font-semibold text-ink">Suppliers &amp; lead times</span>, and the
        forecast fills in as soon as your shops report stock.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">In stock</th>
                <th className="px-4 py-2.5">Per day</th>
                <th className="px-4 py-2.5">Runs out</th>
                <th className="px-4 py-2.5">Order by</th>
                <th className="px-4 py-2.5">How many</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-ink">{r.name}</span>
                    <span className="ml-2 text-[12px] text-faint">{r.sku}</span>
                    {!r.seasonal && (
                      <span className="ml-2 text-[11px] text-muted">no seasonal history yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.stock.quantity ?? '—'}
                    {r.stock.disagrees && (
                      <span className="ml-2 text-[11px]" style={{ color: 'var(--warn)' }}>
                        shops disagree
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{r.burn.toFixed(1)}</td>
                  <td className="px-4 py-2.5">
                    {when(r.forecast.runsOutOn) ?? (
                      <span className="text-muted">{r.forecast.note}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.forecast.daysLate !== null ? (
                      <span style={{ color: 'var(--loss)' }}>
                        order now, {r.forecast.daysLate} days late
                      </span>
                    ) : (
                      (when(r.forecast.orderBy) ?? <span className="text-muted">—</span>)
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.forecast.quantity ?? '—'}
                    {r.forecast.onOrderWithoutEta > 0 && (
                      <span className="ml-2 text-[11px] text-muted">
                        {r.forecast.onOrderWithoutEta} on order, no ETA
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unusable.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <p className="text-[13px] font-semibold text-ink">
            {unusable.length} product{unusable.length === 1 ? '' : 's'} needs a SKU before it can be
            forecast
          </p>
          <p className="mt-1 text-[12px] text-muted">
            These share a SKU that cannot identify a product, so their sales cannot be pooled
            safely. Give each one its own SKU in the webshop.
          </p>
          <ul className="mt-3 space-y-1 text-[12px] text-muted">
            {unusable.map((u, i) => (
              <li key={`${u.shopName}-${u.sku}-${i}`}>
                <span className="text-ink">{u.name}</span> — {u.shopName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
