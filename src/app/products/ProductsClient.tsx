'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { ShopFilter, NO_SHOPS, type Shop } from '@/components/filters/ShopFilter'
import { DateFilter } from '@/components/filters/DateFilter'
import { ProductsTable } from './ProductsTable'
import { groupByCurrency, selectedShops } from '@/lib/currency-groups'
import { useLiveTick } from '@/lib/use-live-tick'
import type { Preset } from '@/lib/dates'
import type { ProductRow, ProductTotals } from '@/lib/metrics/products'

type Payload = {
  displayCurrency: string
  rows: ProductRow[]
  total: ProductTotals
  uncosted: number
  range: { from: string; to: string }
}

/** Skeletons in the shape of the content — never a spinner inside a table. */
function Skeleton() {
  return <div className="skeleton h-[420px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
}

/**
 * Adding NOK to EUR would produce a table that looks meaningful and is not, so
 * the page refuses rather than converting. Each currency group is offered as a
 * button: the fix is one click, not "go and un-tick things".
 */
function MixedCurrencies({
  groups,
  onPick,
}: {
  groups: { currency: string; shops: Shop[] }[]
  onPick: (ids: string[]) => void
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
      <h2 className="text-[13px] font-semibold text-ink">
        Mixed currencies: {groups.map((g) => g.currency).join(' and ')}
      </h2>
      <p className="mt-1 max-w-xl text-[13px] text-muted">
        These stores do not share a currency, so their product totals cannot be added together.
        Pick one group and the figures are exact, in that group’s own currency.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map((g) => (
          <button
            key={g.currency}
            type="button"
            onClick={() => onPick(g.shops.map((s) => s.id))}
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-faint"
          >
            Show the {g.shops.length} {g.currency} {g.shops.length === 1 ? 'store' : 'stores'}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The biggest group among `groups`, which `groupByCurrency` already returns
 * sorted by currency code ascending. `reduce` with a strict `>` means the
 * first group we reach wins any tie for largest — i.e. the
 * alphabetically-earliest currency — so the tiebreak rides that documented
 * sort order rather than any Array.sort stability of our own.
 */
function biggestGroup(groups: { currency: string; shops: Shop[] }[]): { currency: string; shops: Shop[] } {
  return groups.reduce((best, g) => (g.shops.length > best.shops.length ? g : best), groups[0])
}

/**
 * Real accounts routinely span several currencies — refusing to guess is
 * right, but opening on that refusal on every single visit is not. On first
 * load only, and only when the shops actually span more than one currency,
 * narrow silently to the single biggest currency group instead of "all
 * shops": a real, honest table appears immediately, and every other group is
 * still one filter click away. A shop list that already shares one currency
 * is left at [] ("all") — there is nothing to narrow.
 */
function initialSelected(shops: Shop[]): string[] {
  const groups = groupByCurrency(shops)
  if (groups.length <= 1) return []
  return biggestGroup(groups).shops.map((s) => s.id)
}

export function ProductsClient({
  email,
  shops,
  initialPreset,
}: {
  email: string
  shops: Shop[]
  initialPreset?: Preset
}) {
  const [preset, setPreset] = useState<Preset | 'custom'>(initialPreset ?? 'this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string[]>(() => initialSelected(shops))
  // True only while `selected` is still the silent first-load narrowing above
  // — never inferred by comparing arrays, because a user could manually land
  // back on the very same shops the auto-selection picked. An explicit flag
  // does not mistake that for "still auto-selected"; it is cleared the moment
  // ShopFilter's onChange fires at all, below, regardless of what the new
  // selection turns out to be.
  const [autoSelected, setAutoSelected] = useState<boolean>(() => groupByCurrency(shops).length > 1)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const tick = useLiveTick()

  // Decided here rather than on the server: a request that cannot produce an
  // honest answer is better never sent than sent and refused.
  const chosen = selectedShops(shops, selected)
  const groups = groupByCurrency(chosen)
  const mixed = groups.length > 1

  useEffect(() => {
    // Nothing can be honestly loaded across currencies, and nothing here
    // needs to record that: every path that changes `selected` (ShopFilter's
    // onChange, MixedCurrencies' onPick, both below) already sets `loading`
    // itself before it does, and the JSX never reads `loading` while mixed —
    // MixedCurrencies renders in its place. Setting state here would just be
    // a synchronous setState in an effect body with nothing behind it.
    if (mixed) return

    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (selected.length) params.set('shops', selected.join(','))

    const ctrl = new AbortController()
    fetch(`/api/products/analytics?${params}`, { signal: ctrl.signal })
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
  }, [preset, from, to, selected, tick, mixed])

  // Before the first response lands, this still names the right currency: the
  // group is derived client-side from `shops`, the same source of truth the
  // server itself resolves `displayCurrency` from.
  const currency = data?.displayCurrency ?? groups[0]?.currency ?? ''

  return (
    <AppShell email={email}>
      <PageHeader
        title="Products"
        subtitle="Revenue, cost and profit per product. Every figure is exact — nothing is split across products."
      >
        <ShopFilter
          shops={shops}
          selected={selected}
          onChange={(next) => {
            setLoading(true)
            setAutoSelected(false) // a real choice now — no longer an assumption made for them
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
      </PageHeader>

      <PageBody>
        {mixed ? (
          <MixedCurrencies
            groups={groups}
            onPick={(ids) => {
              setLoading(true)
              setSelected(ids)
            }}
          />
        ) : selected.includes(NO_SHOPS) ? (
          <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-8 text-center text-[13px] text-muted">
            No shops selected.
          </p>
        ) : (
          <>
            {autoSelected && (
              <p className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                Showing your {chosen.length} {currency} {chosen.length === 1 ? 'store' : 'stores'}. Pick others in
                the filter.
              </p>
            )}

            {error && (
              <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
                {error}
              </div>
            )}

            {data && data.uncosted > 0 && (
              <p className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                {data.uncosted} {data.uncosted === 1 ? 'product has' : 'products have'} no cost entered, so
                their margins are not real.{' '}
                <Link href="/settings/costs" className="font-semibold text-accent hover:underline">
                  Add costs
                </Link>
              </p>
            )}

            {loading && !data ? (
              <Skeleton />
            ) : data ? (
              <div
                aria-busy={loading}
                className={`transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-50' : ''}`}
              >
                <ProductsTable rows={data.rows} total={data.total} currency={currency} />
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  )
}
