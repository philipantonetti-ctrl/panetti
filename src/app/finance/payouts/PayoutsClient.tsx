'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { FINANCE_TABS, PageTabs } from '@/components/shell/PageTabs'
import { DateFilter, type RangeChoice } from '@/components/filters/DateFilter'
import { formatMoney } from '@/lib/money'
import type { Preset } from '@/lib/dates'

/**
 * The payouts page: every settlement Dintero paid to the bank, and which
 * webshop orders the money came from.
 *
 * This exists for one job - bookkeeping. The bank statement shows one line a
 * week per shop; this page opens that line up into its orders, so a payout
 * reconciles in minutes instead of never. An order the report names that we
 * do not hold is said OUT LOUD, because that gap is the whole point.
 */

export type PayoutRow = {
  id: string
  shopId: string
  shopName: string
  provider: string | null
  settledAt: string | null
  periodStart: string | null
  periodEnd: string | null
  currency: string
  amount: number
  capture: number
  refund: number
  fee: number
  reference: string | null
  linesPending: boolean
  orders: number
  matched: number
}

type Payload = { from: string; to: string; connected: boolean; payouts: PayoutRow[] }

export type PayoutLineRow = {
  id: string
  reference: string
  amount: number
  capture: number
  refund: number
  fee: number
  transactionDate: string | null
  paymentType: string | null
  cardBrand: string | null
  order: { number: string; placedAt: string; status: string; total: number } | null
}

type Detail = { currency: string; linesPending: boolean; lines: PayoutLineRow[] }

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'

const shortDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '?'

function ConnectCta() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-8">
      <h2 className="text-[15px] font-semibold text-ink">Dintero is not connected yet</h2>
      <p className="max-w-xl text-[13px] text-muted">
        Connect each webshop&apos;s Dintero account and this page fills itself: every weekly payout
        with the exact orders behind it, the fees taken, and the bank reference to reconcile
        against. It refreshes on its own a few times a day.
      </p>
      <Link
        href="/settings/payouts"
        className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
      >
        Connect Dintero
      </Link>
    </div>
  )
}

/** How the orders column reads: complete, short, or still being fetched. */
export function ordersCell(p: PayoutRow): { text: string; tone: string } {
  if (p.linesPending) return { text: 'report pending', tone: 'text-faint' }
  if (p.orders === 0) return { text: 'no orders', tone: 'text-faint' }
  if (p.matched === p.orders) return { text: `${p.orders} of ${p.orders}`, tone: 'text-ink' }
  // Short is the state this page exists to surface.
  return { text: `${p.matched} of ${p.orders} matched`, tone: 'text-warn font-semibold' }
}

function Lines({ detail }: { detail: Detail }) {
  if (detail.linesPending) {
    return (
      <p className="px-4 py-3 text-[13px] text-muted">
        The order report for this payout has not been fetched yet. It arrives with the next sync.
      </p>
    )
  }
  if (detail.lines.length === 0) {
    return <p className="px-4 py-3 text-[13px] text-muted">The report lists no orders for this payout.</p>
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-line text-left text-[11px] font-semibold text-faint">
          <th className="px-4 py-2">Order</th>
          <th className="px-3 py-2">Date</th>
          <th className="px-3 py-2">Paid with</th>
          <th className="num px-3 py-2 text-right">Captured</th>
          <th className="num px-3 py-2 text-right">Refunded</th>
          <th className="num px-3 py-2 text-right">Fee</th>
          <th className="num px-4 py-2 text-right">Paid out</th>
        </tr>
      </thead>
      <tbody>
        {detail.lines.map((l) => (
          <tr key={l.id} className="border-b border-line last:border-b-0">
            <td className="px-4 py-2">
              {l.order ? (
                <span className="font-medium text-ink">#{l.order.number}</span>
              ) : (
                // The discrepancy, named: Dintero paid us for an order our
                // webshop mirror does not hold under this reference.
                <span className="font-semibold text-warn">{l.reference || '(no reference)'} - no order with this number</span>
              )}
            </td>
            <td className="num px-3 py-2 text-muted">{shortDay(l.transactionDate ?? l.order?.placedAt ?? null)}</td>
            <td className="px-3 py-2 text-muted">
              {l.cardBrand ?? l.paymentType?.split('.').pop() ?? '-'}
            </td>
            <td className="num px-3 py-2 text-right">{formatMoney(l.capture, detail.currency)}</td>
            <td className="num px-3 py-2 text-right">
              {l.refund !== 0 ? <span className="text-loss">{formatMoney(l.refund, detail.currency)}</span> : '-'}
            </td>
            <td className="num px-3 py-2 text-right text-muted">{formatMoney(-l.fee, detail.currency)}</td>
            <td className="num px-4 py-2 text-right font-medium">{formatMoney(l.amount, detail.currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function PayoutsClient({ email }: { email: string }) {
  const [preset, setPreset] = useState<Preset | 'custom'>('this_month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [shop, setShop] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, Detail>>({})

  useEffect(() => {
    const params = new URLSearchParams()
    if (preset === 'custom' && from && to) {
      params.set('from', from)
      params.set('to', to)
    } else if (preset !== 'custom') {
      params.set('preset', preset)
    }
    const ctrl = new AbortController()
    fetch(`/api/payouts?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the payouts'))))
      .then((body: Payload) => {
        setData(body)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort()
  }, [preset, from, to])

  function pickRange(next: RangeChoice) {
    setPreset(next.preset)
    setFrom(next.from ?? '')
    setTo(next.to ?? '')
  }

  function toggle(id: string) {
    const next = openId === id ? null : id
    setOpenId(next)
    if (next && !details[next]) {
      fetch(`/api/payouts/${next}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the payout'))))
        .then((body: Detail) => setDetails((d) => ({ ...d, [next]: body })))
        .catch(() => {})
    }
  }

  // The shop filter cuts what is shown, not what is fetched: a year of weekly
  // payouts across nine shops is a few hundred small rows.
  const rows = (data?.payouts ?? []).filter((p) => !shop || p.shopId === shop)
  const shops = [...new Map((data?.payouts ?? []).map((p) => [p.shopId, p.shopName])).entries()]

  // Per currency, never one number: NOK, SEK, DKK and EUR payouts are four
  // different things, and one sum across them is arithmetic on nonsense.
  const totals = new Map<string, { amount: number; fee: number }>()
  for (const p of rows) {
    const t = totals.get(p.currency) ?? { amount: 0, fee: 0 }
    t.amount += p.amount
    t.fee += p.fee
    totals.set(p.currency, t)
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Finance"
        subtitle="What Dintero paid out to the bank, opened up into the exact orders behind each payout."
      />
      <PageTabs tabs={FINANCE_TABS} />
      <PageBody>
        {error ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        ) : !data ? (
          <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : !data.connected && data.payouts.length === 0 ? (
          <ConnectCta />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <DateFilter preset={preset} from={data.from} to={data.to} onChange={pickRange} align="left" />
              <select
                aria-label="Shop"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                className="h-8 rounded-[var(--radius-control)] border border-line bg-surface px-2 text-[13px] text-ink"
              >
                <option value="">All shops</option>
                {shops.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="num text-[12px] text-faint">
                {data.from} to {data.to}
              </span>
            </div>

            {totals.size > 0 && (
              <div className="flex flex-wrap gap-2">
                {[...totals.entries()].map(([currency, t]) => (
                  <div
                    key={currency}
                    className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-2.5"
                  >
                    <div className="text-[11px] font-semibold uppercase text-faint">Paid out - {currency}</div>
                    <div className="num text-[15px] font-semibold text-ink">{formatMoney(t.amount, currency)}</div>
                    <div className="num text-[11px] text-muted">fees {formatMoney(t.fee, currency)}</div>
                  </div>
                ))}
              </div>
            )}

            {rows.length === 0 ? (
              <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4 text-[13px] text-muted">
                No payouts in this period. Dintero pays out once a week per shop.
              </p>
            ) : (
              <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
                        <th className="px-4 py-2.5">Paid out</th>
                        <th className="px-3 py-2.5">Shop</th>
                        <th className="px-3 py-2.5">Period</th>
                        <th className="px-3 py-2.5">Bank reference</th>
                        <th className="px-3 py-2.5">Orders</th>
                        <th className="num px-3 py-2.5 text-right">Captured</th>
                        <th className="num px-3 py-2.5 text-right">Refunds</th>
                        <th className="num px-3 py-2.5 text-right">Fees</th>
                        <th className="num px-4 py-2.5 text-right">To the bank</th>
                      </tr>
                    </thead>
                    <tbody className="text-ink">
                      {rows.map((p) => {
                        const cell = ordersCell(p)
                        const open = openId === p.id
                        return (
                          <Fragment key={p.id}>
                            <tr
                              className="cursor-pointer border-b border-line last:border-b-0 hover:bg-panel"
                              onClick={() => toggle(p.id)}
                            >
                              <td className="num px-4 py-2.5 font-medium">
                                <button
                                  type="button"
                                  aria-expanded={open}
                                  aria-label={`Open payout of ${day(p.settledAt)} for ${p.shopName}`}
                                  className="flex items-center gap-1.5"
                                >
                                  <span
                                    aria-hidden
                                    className={`inline-block text-[10px] text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                                  >
                                    ▶
                                  </span>
                                  {p.settledAt ? day(p.settledAt) : <span className="text-warn">not paid yet</span>}
                                </button>
                              </td>
                              <td className="px-3 py-2.5">{p.shopName}</td>
                              <td className="num px-3 py-2.5 text-muted">
                                {shortDay(p.periodStart)} to {shortDay(p.periodEnd)}
                              </td>
                              <td className="num max-w-[180px] truncate px-3 py-2.5 text-muted" title={p.reference ?? ''}>
                                {p.reference ?? '-'}
                              </td>
                              <td className={`num px-3 py-2.5 ${cell.tone}`}>{cell.text}</td>
                              <td className="num px-3 py-2.5 text-right">{formatMoney(p.capture, p.currency)}</td>
                              <td className="num px-3 py-2.5 text-right">
                                {p.refund !== 0 ? (
                                  <span className="text-loss">{formatMoney(p.refund, p.currency)}</span>
                                ) : (
                                  '-'
                                )}
                              </td>
                              <td className="num px-3 py-2.5 text-right text-muted">{formatMoney(-p.fee, p.currency)}</td>
                              <td className="num px-4 py-2.5 text-right font-semibold">
                                {formatMoney(p.amount, p.currency)}
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-b border-line bg-panel/50 last:border-b-0">
                                <td colSpan={9} className="p-0">
                                  {details[p.id] ? (
                                    <Lines detail={details[p.id]} />
                                  ) : (
                                    <div className="skeleton m-3 h-[60px]" style={{ borderRadius: 'var(--radius-card)' }} />
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <p className="text-[11px] text-faint">
              Straight from Dintero&apos;s settlement reports. An order shown in orange is one the
              report names but the webshop mirror does not hold - the gap bookkeeping needs to see.
            </p>
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
