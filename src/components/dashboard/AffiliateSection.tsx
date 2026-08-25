'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

/**
 * Affiliate commissions on the Dashboard, under the compare table: the three
 * figures, then every channel and every shop. It fetches its own numbers with
 * the page's own filter state. It lived on the Marketing page first; the client
 * asked for it here, beside the AFFILIATE COST card it explains.
 *
 * Cost comes from /api/affiliate/summary, which follows the engine's own
 * conventions, so what is here and what the headline charges to net profit are
 * the same money.
 */

type Slice = { sales: number; orderValue: number; cost: number }
type ShopRow = Slice & { shopId: string; shopName: string }
type ChannelRow = Slice & { channelId: string; channelName: string }
type Payload = {
  connected: boolean
  displayCurrency: string
  total: Slice
  byShop: ShopRow[]
  byChannel: ChannelRow[]
  unmatched: number
  // What those unmatched sales cost, converted like everything else. Kept OUT
  // of total.cost on purpose: the total must stay exactly the engine's figure.
  unmatchedCost: number
}

/** Same grouping as the tables beside it; the three sit on one page. */
const count = (n: number) => Math.round(n).toLocaleString('en-US')

const TH = 'px-5 py-3 text-right'

function Table<Row>({
  heading,
  rows,
  keyOf,
  labelOf,
  currency,
}: {
  heading: string
  rows: (Row & Slice)[]
  keyOf: (row: Row & Slice) => string
  labelOf: (row: Row & Slice) => string
  currency: string
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
              <th scope="col" className="px-5 py-3 text-left">
                {heading}
              </th>
              <th scope="col" className={TH}>
                SALES
              </th>
              <th scope="col" className={TH}>
                ORDER VALUE
              </th>
              <th scope="col" className={TH}>
                COST
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r)} className="border-b border-line last:border-0">
                <td className="px-5 py-3 text-ink">{labelOf(r)}</td>
                <td className="num px-5 py-3 text-right text-muted">{count(r.sales)}</td>
                <td className="num px-5 py-3 text-right text-muted">
                  {formatMoney(r.orderValue, currency)}
                </td>
                <td className="num px-5 py-3 text-right font-semibold text-ink">
                  {formatMoney(r.cost, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function AffiliateSection({
  preset,
  from,
  to,
  shops,
  tick,
}: {
  preset: Preset | 'custom'
  from: string
  to: string
  shops: string[]
  tick: number
}) {
  const [data, setData] = useState<Payload | null>(null)
  // A failed refresh must not silently pass off the previous range's figures as
  // this one's - the numbers stay (they were true once) and say so.
  const [stale, setStale] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    if (shops.length) params.set('shops', shops.join(','))

    const ctrl = new AbortController()
    fetch(`/api/affiliate/summary?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load the affiliate figures')
        return (await res.json()) as Payload
      })
      .then((json) => {
        setData(json)
        setStale(false)
      })
      .catch((e: Error) => {
        // The first load failing leaves `data` null, and the section simply
        // does not appear - it has nothing it could honestly claim yet.
        if (e.name !== 'AbortError') setStale(true)
      })
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [preset, from, to, shops, tick])

  // Nothing connected and nothing recorded: the section does not exist. But
  // unmatched sales ARE recorded money - a workspace whose rows all failed to
  // match a shop, with its account then paused, has zero tracked sales and
  // still needs the warning below, which is the only thing explaining where
  // that money went.
  if (!data || (!data.connected && data.total.sales === 0 && data.unmatched === 0)) return null

  const currency = data.displayCurrency
  const stats = [
    { label: 'AFFILIATE COST', value: formatMoney(data.total.cost, currency) },
    { label: 'TRACKED SALES', value: count(data.total.sales) },
    { label: 'TRACKED ORDER VALUE', value: formatMoney(data.total.orderValue, currency) },
  ]

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">Affiliate</h2>
        <p className="text-[12px] text-muted">
          Addrevenue commissions + platform fee - counted into net profit as their own cost line.
        </p>
      </div>

      {stale && (
        <p className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
          These figures could not be refreshed, so they are the last ones that loaded.
        </p>
      )}

      <div className="grid grid-cols-2 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface lg:grid-cols-3">
        {stats.map((s, i) => (
          <div
            key={s.label}
            className={`px-5 py-4 ${i < stats.length - 1 ? 'border-b border-line lg:border-b-0 lg:border-r' : ''}`}
          >
            <p className="text-[11px] font-semibold tracking-wide text-faint">{s.label}</p>
            <p className="num mt-1 text-[22px] font-semibold text-ink">{s.value}</p>
          </div>
        ))}
      </div>

      {data.unmatched > 0 && (
        <p className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
          {/* The route filters unmatched rows out of EVERYTHING it sums, so
              this must not read as a per-shop-table footnote: the money is
              absent from the headline total and the channel table too. */}
          {formatMoney(data.unmatchedCost, currency)} of affiliate cost ({data.unmatched}{' '}
          {data.unmatched === 1 ? 'sale' : 'sales'}) belongs to an Addrevenue market that matches
          none of the shops, so it is missing from every figure here - including the total above.
          Check the shops’ URLs on the{' '}
          <Link href="/settings/affiliate" className="font-semibold text-accent hover:underline">
            Affiliate settings page
          </Link>
          .
        </p>
      )}

      {data.byChannel.length > 0 && (
        <Table
          heading="CHANNEL"
          rows={data.byChannel}
          keyOf={(r) => r.channelId}
          labelOf={(r) => r.channelName}
          currency={currency}
        />
      )}

      {/* One shop's table would just restate the totals above it. */}
      {data.byShop.length > 1 && (
        <Table
          heading="SHOP"
          rows={data.byShop}
          keyOf={(r) => r.shopId}
          labelOf={(r) => r.shopName}
          currency={currency}
        />
      )}
    </section>
  )
}
