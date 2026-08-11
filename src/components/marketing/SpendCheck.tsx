'use client'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { SpendCheckAccount, SpendCheckResult } from '@/lib/ads/spend-check'

/**
 * Where the ad spend total came from, account by account.
 *
 * "Native total" is the column that does the work: the account's own money in
 * its own currency, unconverted, so it can be read straight across to Ads
 * Manager. Everything else on this page is consolidated, and a consolidated
 * figure cannot be checked against anything.
 *
 * `allStores` guards a second way this panel could mislead: an account that
 * is "split by campaign" runs campaigns for several stores, and when the page
 * is filtered to a subset, its nativeTotal only covers the campaigns for
 * those stores (see src/lib/ads/attribution.ts:191-195). Read against the
 * whole account in Ads Manager, that partial total looks like missing spend
 * when nothing is actually missing — so the panel says so, in plain words,
 * whenever the page isn't showing every store.
 *
 * `partialAccounts` covers the same caution for the one case `allStores`
 * cannot see: "all stores" (the empty selection) still only ever means all
 * ACTIVE stores, so a split account with a campaign mapped to a deactivated
 * shop is partial even though nothing was filtered. The route computes this
 * from the data (src/lib/ads/attribution.ts, hasPartialSplitAccounts) and
 * the caution shows whenever either signal is true.
 */

const STATUS_TEXT: Record<SpendCheckAccount['status'], string> = {
  ok: 'ok',
  error: 'sync failed',
  stale: 'not synced today',
  inactive: 'switched off',
}

function ago(date: Date | null): string {
  if (!date) return 'never'
  const hours = Math.round((Date.now() - date.getTime()) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * "3 / 10" alone reads the same whether an account synced 1-3 Aug then
 * stopped, or delivered on the 8th, 9th and 10th — those mean completely
 * different things. `null` means no data at all, which is handled by simply
 * showing nothing here (the count on its own already says "0").
 */
function dataSpan(a: Pick<SpendCheckAccount, 'firstDay' | 'lastDay'>): string | null {
  if (!a.firstDay || !a.lastDay) return null
  return a.firstDay === a.lastDay ? formatDay(a.firstDay) : `${formatDay(a.firstDay)}–${formatDay(a.lastDay)}`
}

export function SpendCheck({
  data,
  currency,
  allStores,
  partialAccounts = false,
}: {
  data: SpendCheckResult
  currency: string
  allStores: boolean
  /** True when a split account in scope has a campaign resolving outside it — see the note above. */
  partialAccounts?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (data.accounts.length === 0) return null

  const troubled = data.accounts.filter((a) => a.status !== 'ok')
  const showPartialCaution = !allStores || partialAccounts

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface">
      {data.needsAttention && (
        <p
          data-testid="spend-check-banner"
          className="border-b border-line px-5 py-3 text-[13px] text-loss"
        >
          {troubled.length === 1
            ? `${troubled[0].name} is not reporting normally (${STATUS_TEXT[troubled[0].status]}), so spend for it may be incomplete.`
            : `${troubled.length} ad accounts are not reporting normally, so spend may be incomplete.`}
        </p>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <span className="text-[13px] font-semibold text-ink">Spend check</span>
        <span className="text-[12px] text-muted">
          {data.accounts.length} {data.accounts.length === 1 ? 'account' : 'accounts'} · {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        <div className="border-t border-line">
          {showPartialCaution && (
            <p data-testid="spend-check-caution" className="border-b border-line px-5 py-3 text-[13px] text-muted">
              This may be showing only part of an ad account. An account that runs campaigns for
              several stores shows just the part that belongs to the stores in view here, so its
              total can read lower than what you see in Ads Manager.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] font-semibold tracking-wide text-faint">
                  <th scope="col" className="px-5 py-3 text-left">ACCOUNT</th>
                  <th scope="col" className="px-5 py-3 text-right" title="The account's own currency, unconverted — compare this against Ads Manager">
                    NATIVE TOTAL
                  </th>
                  <th scope="col" className="px-5 py-3 text-right">IN {currency}</th>
                  <th scope="col" className="px-5 py-3 text-right" title="Days in the range carrying data. A platform reports no row for a day it delivered nothing, so a lower number is not automatically a fault.">
                    DAYS WITH DATA
                  </th>
                  <th scope="col" className="px-5 py-3 text-right">LAST SYNC</th>
                  <th scope="col" className="px-5 py-3 text-left">STATUS</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 text-ink">
                      {a.name}
                      <span className="ml-2 text-[11px] text-faint">{a.provider}</span>
                    </td>
                    <td data-testid={`native-${a.id}`} className="num px-5 py-3 text-right font-semibold text-ink">
                      {formatMoney(a.nativeTotal, a.currency)}
                    </td>
                    <td className="num px-5 py-3 text-right text-muted">
                      {formatMoney(a.convertedTotal, currency)}
                    </td>
                    <td data-testid={`days-${a.id}`} className="num px-5 py-3 text-right text-muted">
                      <div>{a.daysWithData} / {a.daysInRange}</div>
                      {dataSpan(a) && <div className="text-[11px] text-faint">{dataSpan(a)}</div>}
                    </td>
                    <td className="num px-5 py-3 text-right text-muted">{ago(a.lastSyncAt)}</td>
                    <td className={`px-5 py-3 ${a.status === 'ok' ? 'text-muted' : 'text-loss'}`}>
                      {a.lastError ?? STATUS_TEXT[a.status]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
