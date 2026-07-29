'use client'

import { formatMoney } from '@/lib/money'
import type { MarketingShopRow } from '@/lib/ads/marketing'

/**
 * The headline ad figures. One surface split by hairlines, like the dashboard's
 * strip. A dash is honest where a ratio has no denominator.
 */

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="px-5 py-4" title={hint}>
      <p className="text-[11px] font-semibold tracking-wide text-faint">{label}</p>
      <p className="num mt-1 text-[22px] font-semibold text-ink">{value}</p>
    </div>
  )
}

export function MarketingStats({ total, currency }: { total: MarketingShopRow; currency: string }) {
  return (
    <section className="grid grid-cols-2 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:grid-cols-4">
      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="AD SPEND"
          value={formatMoney(total.spend, currency)}
          hint="Meta and Google combined, for the selected shops and period"
        />
      </div>
      <div className="border-b border-line lg:border-b-0 lg:border-r">
        <Stat
          label="ROAS"
          value={total.roas === null ? '—' : `${total.roas.toFixed(2)}×`}
          hint="Gross revenue divided by ad spend"
        />
      </div>
      <div className="lg:border-r lg:border-line">
        <Stat
          label="CPA"
          value={total.cpa === null ? '—' : formatMoney(total.cpa, currency)}
          hint="Ad spend per paid order"
        />
      </div>
      <Stat
        label="CPC"
        value={total.cpc === null ? '—' : formatMoney(total.cpc, currency)}
        hint="Ad spend per click"
      />
    </section>
  )
}
