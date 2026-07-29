'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { MarketingStats } from '@/components/marketing/MarketingStats'
import { MarketingChart } from '@/components/marketing/MarketingChart'
import { MarketingTable } from '@/components/marketing/MarketingTable'
import { useLiveTick } from '@/lib/use-live-tick'
import type { Preset } from '@/lib/dates'
import type { MarketingSeriesPoint, MarketingShopRow } from '@/lib/ads/marketing'

type Payload = {
  displayCurrency: string
  byShop: MarketingShopRow[]
  total: MarketingShopRow
  series: MarketingSeriesPoint[]
  connected: boolean
}

/** Skeletons in the shape of the content — never a spinner in the middle of a table. */
function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="skeleton h-[88px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[318px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
      <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
    </div>
  )
}

/** The page before any account exists: say what this is and where to begin. */
function ConnectCta() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-8">
      <h2 className="text-[15px] font-semibold text-ink">No ad accounts connected yet</h2>
      <p className="max-w-xl text-[13px] text-muted">
        Connect your Meta and Google ad accounts and this page fills itself: daily ad spend
        next to the revenue it drove, with ROAS, cost per order and cost per click for every
        shop. Spend syncs automatically a few times a day.
      </p>
      <Link
        href="/settings/ad-accounts"
        className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
      >
        Connect an ad account
      </Link>
    </div>
  )
}

export function MarketingClient({
  email,
  shops,
  initialPreset,
  hasAccounts,
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
  hasAccounts: boolean
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // The cron keeps the DATABASE current; this keeps the TAB current.
  const tick = useLiveTick()

  useEffect(() => {
    if (!hasAccounts) return // nothing to fetch; the page is a doorway

    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    const ctrl = new AbortController()
    fetch(`/api/marketing?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load')
        return res.json()
      })
      .then((json: Payload) => {
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, selected, tick, hasAccounts])

  const currency = data?.displayCurrency ?? 'USD'

  return (
    <AppShell email={email}>
      <PageHeader
        title="Marketing"
        subtitle={
          hasAccounts && shops.length > 1 && currency === 'USD'
            ? 'Shops trade in different currencies, so totals are consolidated to USD at each day’s own rate.'
            : undefined
        }
      >
        {hasAccounts && (
          <>
            <ShopFilter
              shops={shops}
              selected={selected}
              onChange={(next) => {
                setLoading(true)
                setSelected(next)
              }}
            />
            <DateFilter
              preset={preset}
              from={from}
              to={to}
              onChange={(next) => {
                setLoading(true)
                setPreset(next.preset)
                if (next.from !== undefined) setFrom(next.from)
                if (next.to !== undefined) setTo(next.to)
              }}
            />
          </>
        )}
      </PageHeader>

      <PageBody>
        {!hasAccounts ? (
          <ConnectCta />
        ) : (
          <>
            {error && (
              <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
                {error}
              </div>
            )}

            {loading && !data ? (
              <Skeleton />
            ) : data ? (
              <div
                aria-busy={loading}
                className={`space-y-4 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
              >
                <MarketingStats total={data.total} currency={currency} />

                <MarketingChart series={data.series} currency={currency} />

                <MarketingTable rows={data.byShop} total={data.total} currency={currency} />
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  )
}
