'use client'

import { formatMoney } from '@/lib/money'
import type { MarketingPlatformRow } from '@/lib/ads/marketing'

/**
 * Where the ad money went, by platform. The bar is the share of total spend -
 * a reading aid, never the number itself, which is always printed beside it.
 */

const BAR: Record<string, string> = {
  meta: 'var(--color-series-revenue)',
  google: 'var(--color-series-profit)',
}

export function PlatformCard({
  rows,
  total,
  currency,
}: {
  rows: MarketingPlatformRow[]
  total: number
  currency: string
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-[13px] font-semibold text-ink">Ad spend</h2>

      {rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">No spend to break down.</p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            {rows.map((r) => (
              <div key={r.provider}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink">{r.label}</span>
                  <span className="num text-[13px] font-semibold text-ink">
                    {formatMoney(r.spend, currency)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel">
                  <div
                    data-testid={`share-${r.provider}`}
                    className="h-full rounded-full"
                    style={{ width: `${r.share * 100}%`, background: BAR[r.provider] ?? 'var(--color-decor)' }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[11px] font-semibold tracking-wide text-faint">TOTAL AD SPEND</p>
            <p className="num mt-1 text-[22px] font-semibold text-ink">
              {formatMoney(total, currency)}
            </p>
          </div>
        </>
      )}
    </section>
  )
}
