'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { AMBASSADOR_TABS, PageTabs } from '@/components/shell/PageTabs'
import { Leaderboard } from '@/components/dashboard/Leaderboard'
import { PRESET_LABELS, type Preset } from '@/lib/dates'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'
import { ProductOverview, type ProductSummaryRow } from '@/components/ambassadors/ProductOverview'

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** The period choices for the statistics - the everyday ones, nothing exotic. */
const STAT_PRESETS: Preset[] = ['this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_year']

type Stats = {
  leaderboard: LeaderboardRow[]
  shopOptions: { id: string; name: string }[]
  displayCurrency: string
}

/**
 * The Ambassadors tab: who sold what, filtered by shop and period, and how far
 * each product has spread. Adding one, their codes and their invite links are
 * the next tab's (AddAmbassadorClient); they used to sit under these figures
 * on one long page.
 */
export function AmbassadorsClient({
  email,
  role = 'ADMIN',
}: {
  email: string
  role?: 'ADMIN' | 'MARKETING'
}) {
  // The statistics: who sold, filtered by shop and period.
  const [stats, setStats] = useState<Stats | null>(null)
  const [statShop, setStatShop] = useState('') // '' = all shops
  const [statPreset, setStatPreset] = useState<Preset>('this_month')
  useEffect(() => {
    let live = true
    const params = new URLSearchParams({ preset: statPreset })
    if (statShop) params.set('shops', statShop)
    fetch(`/api/ambassadors/stats?${params}`)
      .then(async (r) => (r.ok ? ((await r.json()) as Stats) : null))
      .then((data) => {
        if (live && data) setStats(data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [statShop, statPreset])

  // How many ambassadors hold each product. Read once on arrival: the roster
  // tab is where products are handed out, and coming back here reads it again.
  const [overview, setOverview] = useState<ProductSummaryRow[]>([])
  useEffect(() => {
    let live = true
    fetch('/api/ambassador-products')
      .then(async (r) => (r.ok ? ((await r.json()) as { overview?: ProductSummaryRow[] }) : null))
      .then((data) => {
        if (live && data) setOverview(data.overview ?? [])
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  return (
    <AppShell email={email} role={role}>
      <PageHeader
        title="Ambassadors"
        subtitle="Who sold what, by shop and period, and how far each product has spread."
      >
        <select
          aria-label="Shops"
          value={statShop}
          onChange={(e) => setStatShop(e.target.value)}
          className={INPUT}
        >
          <option value="">All shops</option>
          {(stats?.shopOptions ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Period"
          value={statPreset}
          onChange={(e) => setStatPreset(e.target.value as Preset)}
          className={INPUT}
        >
          {STAT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </PageHeader>

      <PageTabs tabs={AMBASSADOR_TABS} />

      <PageBody>
        {stats && <Leaderboard rows={stats.leaderboard} currency={stats.displayCurrency} />}
        <ProductOverview rows={overview} />
      </PageBody>
    </AppShell>
  )
}
