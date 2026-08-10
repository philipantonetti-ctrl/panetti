'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, NO_SHOPS, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { MarketingStats } from '@/components/marketing/MarketingStats'
import { MarketingChart } from '@/components/marketing/MarketingChart'
import { MarketingTable } from '@/components/marketing/MarketingTable'
import { PlatformCard } from '@/components/marketing/PlatformCard'
import { PlatformTable } from '@/components/marketing/PlatformTable'
import { SpendCheck } from '@/components/marketing/SpendCheck'
import { BreakdownTable } from './BreakdownTable'
import { useLiveTick } from '@/lib/use-live-tick'
import type { Preset } from '@/lib/dates'
import type { MarketingPlatformRow, MarketingSeriesPoint, MarketingShopRow } from '@/lib/ads/marketing'
import type { SpendCheckResult } from '@/lib/ads/spend-check'

type Payload = {
  displayCurrency: string
  byShop: MarketingShopRow[]
  byPlatform: MarketingPlatformRow[]
  total: MarketingShopRow
  series: MarketingSeriesPoint[]
  spendCheck: SpendCheckResult
  connected: boolean
  // How many campaigns on a split account in scope still have no store. Their
  // spend already lands on the account's default shop (never dropped), but
  // the design requires that fallback to be visible, not silent — the same
  // reasoning as ProductsClient's uncosted-products notice.
  unassignedCampaigns: number
  // Already sent by the route (src/app/api/marketing/route.ts) — the resolved
  // range for whichever preset or custom dates are in effect. BreakdownTable
  // needs concrete dates, not a preset name, so this is read rather than
  // re-derived: re-resolving 'this_month' client-side would risk disagreeing
  // with the server's own timezone-aware resolution near a day boundary.
  range: { from: string; to: string }
}

const PLATFORMS: { id: 'meta' | 'google'; label: string }[] = [
  { id: 'meta', label: 'Meta' },
  { id: 'google', label: 'Google' },
]

/** Two options, so a segmented control — a dropdown would hide half of them. */
function PlatformSwitcher({
  provider,
  onChange,
}: {
  provider: 'meta' | 'google'
  onChange: (next: 'meta' | 'google') => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Platform"
      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
    >
      {PLATFORMS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={provider === p.id}
          onClick={() => onChange(p.id)}
          className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 ${
            provider === p.id ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-panel hover:text-ink'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Campaigns belong to one ad account. Summing them across stores would look
 * like a real table and mean nothing — so the breakdown only ever mounts for
 * exactly one selected shop, never "all" (the default) and never several.
 */
function SingleStoreOnly() {
  return (
    <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4 text-[13px] text-muted">
      Campaigns belong to one ad account, so stacking them across stores would produce a table that
      looks meaningful and is not.
    </p>
  )
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
  const [provider, setProvider] = useState<'meta' | 'google'>('meta')

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
        // JSON has no Date type; SpendCheck does date arithmetic on this.
        json.spendCheck.accounts = json.spendCheck.accounts.map((a) => ({
          ...a,
          lastSyncAt: a.lastSyncAt ? new Date(a.lastSyncAt) : null,
        }))
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
  // A real shop id only when exactly one is chosen — ShopFilter's own "all"
  // (empty array) and its explicit "none" sentinel both fail this on purpose.
  const singleShopId = selected.length === 1 && selected[0] !== NO_SHOPS ? selected[0] : null

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

            {data && data.unassignedCampaigns > 0 && (
              <p className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                {data.unassignedCampaigns} {data.unassignedCampaigns === 1 ? 'campaign has' : 'campaigns have'} no
                store assigned, so their spend falls back to their account&apos;s default store.{' '}
                <Link href="/settings/ad-accounts" className="font-semibold text-accent hover:underline">
                  Assign campaigns
                </Link>
              </p>
            )}

            {loading && !data ? (
              <Skeleton />
            ) : data ? (
              <div
                aria-busy={loading}
                className={`space-y-4 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
              >
                <MarketingStats total={data.total} currency={currency} />

                <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
                  <PlatformCard rows={data.byPlatform} total={data.total.spend} currency={currency} />
                  <MarketingChart series={data.series} currency={currency} />
                </div>

                <PlatformTable rows={data.byPlatform} currency={currency} />

                <MarketingTable rows={data.byShop} total={data.total} currency={currency} />

                {singleShopId ? (
                  <div className="space-y-3">
                    <PlatformSwitcher provider={provider} onChange={setProvider} />
                    <BreakdownTable
                      shopId={singleShopId}
                      provider={provider}
                      from={data.range.from}
                      to={data.range.to}
                    />
                  </div>
                ) : (
                  <SingleStoreOnly />
                )}

                <SpendCheck data={data.spendCheck} currency={currency} allStores={selected.length === 0} />
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  )
}
