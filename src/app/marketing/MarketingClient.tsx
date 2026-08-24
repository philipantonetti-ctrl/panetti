'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { ShopFilter, NO_SHOPS, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { PlatformFilter } from '@/components/filters/PlatformFilter'
import { MarketingStats } from '@/components/marketing/MarketingStats'
import { MarketingChart } from '@/components/marketing/MarketingChart'
import { MarketingTable } from '@/components/marketing/MarketingTable'
import { PlatformCard } from '@/components/marketing/PlatformCard'
import { PlatformTable } from '@/components/marketing/PlatformTable'
import { SpendCheck } from '@/components/marketing/SpendCheck'
import { BreakdownTable } from './BreakdownTable'
import { AffiliateSection } from './AffiliateSection'
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
  // True when a split account in scope has a campaign resolving outside
  // scope — "all stores" still only ever means all ACTIVE stores, so this
  // can be true even with nothing filtered (src/lib/ads/attribution.ts,
  // hasPartialSplitAccounts). Drives SpendCheck's partial-scope caution
  // alongside the ShopFilter selection itself.
  partialAccounts: boolean
  // Already sent by the route (src/app/api/marketing/route.ts) — the resolved
  // range for whichever preset or custom dates are in effect. BreakdownTable
  // needs concrete dates, not a preset name, so this is read rather than
  // re-derived: re-resolving 'this_month' client-side would risk disagreeing
  // with the server's own timezone-aware resolution near a day boundary.
  range: { from: string; to: string }
  // Echoed straight from the query the route actually served (route.ts) —
  // NOT re-derived from the client's own `platform` state, which is pending
  // the instant a filter changes and can outrun the fetch it triggered. The
  // chart and table divide whole-store figures by spend; they must gate that
  // display on the platform that produced the numbers on screen, not the one
  // the user just clicked, or a failed refetch leaves them showing inflated
  // ratios forever (see the `platformFiltered` prop below).
  platform: string | null
}

const PLATFORMS: { id: 'meta' | 'google'; label: string }[] = [
  { id: 'meta', label: 'Meta' },
  { id: 'google', label: 'Google' },
]

/** Narrows the page's free-text platform filter to the two the drill-down
 *  actually knows how to show. Anything else (workspace has some third
 *  provider connected) leaves the switcher in charge rather than locking to
 *  a platform BreakdownTable cannot render. */
function asBreakdownProvider(platform: string | null): 'meta' | 'google' | null {
  return platform === 'meta' || platform === 'google' ? platform : null
}

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
  hasAffiliate = false,
  platforms = [],
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
  hasAccounts: boolean
  // Whether any active affiliate account exists (src/app/marketing/page.tsx).
  // The AffiliateSection below answers to the page's date and shop filters, so
  // those filters must exist for a workspace with affiliate data but no
  // Meta/Google account — otherwise its one section is frozen at the default
  // preset and every shop.
  hasAffiliate?: boolean
  // Workspace-level list of connected platforms, from the server component
  // (src/app/marketing/page.tsx) — never from a /api/marketing response,
  // whose byPlatform narrows to whatever platform filter is active and would
  // strand the dropdown on the one option already chosen.
  platforms?: { provider: string; label: string }[]
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [platform, setPlatform] = useState<string | null>(null)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [provider, setProvider] = useState<'meta' | 'google'>('meta')
  const [syncing, setSyncing] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const toast = useToast()

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
    if (platform) params.set('platform', platform)

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
        // Normalised, not trusted blindly: an older route response (or a test
        // fixture predating this field) has no `platform` key at all, and
        // `undefined !== null` would wrongly read as "filtered".
        json.platform = json.platform ?? null
        setData(json)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, selected, platform, tick, refreshNonce, hasAccounts])

  const currency = data?.displayCurrency ?? 'USD'
  // A real shop id only when exactly one is chosen — ShopFilter's own "all"
  // (empty array) and its explicit "none" sentinel both fail this on purpose.
  const singleShopId = selected.length === 1 && selected[0] !== NO_SHOPS ? selected[0] : null
  // A page filter narrowed to Meta and a drill-down open on Google would put
  // two scopes on one screen under one header. Read off the pending
  // `platform` selection (not `data.platform`): BreakdownTable makes its own
  // independent fetch and shows its own loading/error state, so — unlike the
  // whole-store ratios in Finding 1 — there is no stale-data risk in
  // following the filter immediately.
  const lockedProvider = asBreakdownProvider(platform)
  const breakdownProvider = lockedProvider ?? provider

  async function refresh() {
    setSyncing(true)
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      // The sync wrote to the database; this pulls it into the tab.
      setLoading(true)
      setRefreshNonce((n) => n + 1)
      toast.success('Ad spend refreshed')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Marketing"
        subtitle={
          hasAccounts && shops.length > 1
            ? `Shops trade in different currencies, so totals are consolidated to ${currency} at each day’s own rate.`
            : undefined
        }
      >
        {/* The filter header exists for either channel: the AffiliateSection
            reads these same date/shop states, so affiliate data alone earns
            the controls. Note the setLoading(true) in these handlers is never
            cleared when hasAccounts is false (the fetch effect returns early)
            — harmless today because `loading` is only read inside the
            hasAccounts branch below. */}
        {(hasAccounts || hasAffiliate) && (
          <>
            {/* Self-hides for an affiliate-only workspace: page.tsx derives
                `platforms` from ad accounts, so it is empty here and
                PlatformFilter renders nothing below two options. */}
            <PlatformFilter
              options={platforms}
              selected={platform}
              onChange={(next) => {
                setLoading(true)
                setPlatform(next)
              }}
            />
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
            {/* Syncs AD spend — meaningless without an ad account, so it keeps
                the narrower gate. */}
            {hasAccounts && (
              <button
                type="button"
                onClick={refresh}
                disabled={syncing}
                className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:border-faint disabled:opacity-50"
              >
                {syncing ? 'Refreshing…' : 'Refresh ad data'}
              </button>
            )}
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
                  <MarketingChart
                    series={data.series}
                    currency={currency}
                    // Gated on the platform that produced `data`, not the
                    // pending `platform` selection — see the `Payload.platform`
                    // comment above for why that distinction is load-bearing.
                    platformFiltered={data.platform !== null}
                  />
                </div>

                <PlatformTable rows={data.byPlatform} currency={currency} />

                <MarketingTable
                  rows={data.byShop}
                  total={data.total}
                  currency={currency}
                  platformFiltered={data.platform !== null}
                />

                {singleShopId ? (
                  <div className="space-y-3">
                    {/* A page platform filter is already a scope decision; a
                        visible switcher would just offer to contradict it. */}
                    {!lockedProvider && <PlatformSwitcher provider={provider} onChange={setProvider} />}
                    <BreakdownTable
                      shopId={singleShopId}
                      provider={breakdownProvider}
                      from={data.range.from}
                      to={data.range.to}
                    />
                  </div>
                ) : (
                  <SingleStoreOnly />
                )}

                <SpendCheck
                  data={data.spendCheck}
                  currency={currency}
                  allStores={selected.length === 0}
                  partialAccounts={data.partialAccounts}
                />
              </div>
            ) : null}
          </>
        )}

        {/* Outside the ternary on purpose: the affiliate program is its own
            channel, not a subset of paid ads, so it must still be here for a
            workspace that has never connected a Meta or Google account. It
            renders nothing at all when there is no affiliate program either. */}
        <div className="mt-4">
          <AffiliateSection preset={preset} from={from} to={to} shops={selected} tick={tick} />
        </div>
      </PageBody>
    </AppShell>
  )
}
