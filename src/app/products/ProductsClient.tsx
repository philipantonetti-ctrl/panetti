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
  const [selected, setSelected] = useState<string[]>([])
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
    if (mixed) {
      setLoading(false)
      return
    }

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

  const currency = data?.displayCurrency ?? ''

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
