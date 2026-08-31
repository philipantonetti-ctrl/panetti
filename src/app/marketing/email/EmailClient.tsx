'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { MARKETING_TABS, PageTabs } from '@/components/shell/PageTabs'
import { formatMoney } from '@/lib/money'

/**
 * The email campaigns, read from our own mirror of Klaviyo's reporting.
 *
 * A table rather than a dashboard: the question this page answers is "what
 * did each send do", and the campaign row - recipients, who opened, who
 * clicked, what it earned - IS the answer. Rates are computed here from the
 * counts, so the two can never disagree on screen.
 */

export type EmailCampaign = {
  campaignId: string
  name: string
  channel: string
  sentAt: string | null
  recipients: number
  opens: number
  clicks: number
  conversions: number
  conversionValue: number
}

type Payload = {
  connected: boolean
  currency?: string
  hasOrderMetric?: boolean
  lastSyncAt?: string | null
  lastError?: string | null
  campaigns: EmailCampaign[]
}

/** A share of recipients, or a dash where nothing was sent to anyone. */
function rate(part: number, recipients: number): string {
  if (recipients === 0) return '-'
  return `${((part / recipients) * 100).toFixed(1)}%`
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '-')

function ConnectCta() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-6 py-8">
      <h2 className="text-[15px] font-semibold text-ink">Klaviyo is not connected yet</h2>
      <p className="max-w-xl text-[13px] text-muted">
        Connect the Klaviyo account and this page fills itself: every email and SMS campaign with
        its recipients, open rate, click rate and the revenue it drove. It refreshes on its own a
        few times a day.
      </p>
      <Link
        href="/settings/email"
        className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
      >
        Connect Klaviyo
      </Link>
    </div>
  )
}

export function CampaignTable({
  campaigns,
  currency,
  hasOrderMetric,
}: {
  campaigns: EmailCampaign[]
  currency: string
  hasOrderMetric: boolean
}) {
  if (campaigns.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4 text-[13px] text-muted">
        Connected, waiting for the first campaigns to arrive. The sync runs a few times a day.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
              <th className="px-4 py-2.5">Campaign</th>
              <th className="px-3 py-2.5">Sent</th>
              <th className="num px-3 py-2.5 text-right">Recipients</th>
              <th className="num px-3 py-2.5 text-right">Open rate</th>
              <th className="num px-3 py-2.5 text-right">Click rate</th>
              {hasOrderMetric && <th className="num px-3 py-2.5 text-right">Orders</th>}
              {hasOrderMetric && <th className="num px-4 py-2.5 text-right">Revenue</th>}
            </tr>
          </thead>
          <tbody className="text-ink">
            {campaigns.map((c) => (
              <tr key={c.campaignId} className="border-b border-line last:border-b-0 hover:bg-panel">
                <td className="max-w-[320px] truncate px-4 py-2.5 font-medium" title={c.name}>
                  {c.name}
                  {c.channel !== 'email' && (
                    <span className="ml-1.5 rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold uppercase text-faint">
                      {c.channel}
                    </span>
                  )}
                </td>
                <td className="num px-3 py-2.5 text-muted">{when(c.sentAt)}</td>
                <td className="num px-3 py-2.5 text-right">{c.recipients.toLocaleString('en-US')}</td>
                <td className="num px-3 py-2.5 text-right">{rate(c.opens, c.recipients)}</td>
                <td className="num px-3 py-2.5 text-right">{rate(c.clicks, c.recipients)}</td>
                {hasOrderMetric && (
                  <td className="num px-3 py-2.5 text-right">{c.conversions.toLocaleString('en-US')}</td>
                )}
                {hasOrderMetric && (
                  <td className="num px-4 py-2.5 text-right">{formatMoney(c.conversionValue, currency)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function EmailClient({ email }: { email: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/marketing/email', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the email campaigns'))))
      .then((body: Payload) => setData(body))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort()
  }, [])

  return (
    <AppShell email={email}>
      <PageHeader
        title="Marketing"
        subtitle="What each Klaviyo campaign did: who it reached, who opened, and what it earned."
      />
      <PageTabs tabs={MARKETING_TABS} />
      <PageBody>
        {error ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        ) : !data ? (
          <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : !data.connected ? (
          <ConnectCta />
        ) : (
          <div className="space-y-3">
            {data.lastError && (
              <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-warn">
                Last sync: {data.lastError}
              </div>
            )}
            {!data.hasOrderMetric && (
              <p className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                This Klaviyo account has no Placed Order metric, so revenue cannot be attributed to
                campaigns - opens and clicks still are.
              </p>
            )}
            <CampaignTable
              campaigns={data.campaigns}
              currency={data.currency ?? 'USD'}
              hasOrderMetric={data.hasOrderMetric ?? false}
            />
            {data.lastSyncAt && (
              <p className="text-[11px] text-faint">
                Last refreshed {new Date(data.lastSyncAt).toLocaleString()} - campaign figures update a
                few times a day.
              </p>
            )}
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
