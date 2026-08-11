'use client'

import { useState } from 'react'
import { PageBody, PageHeader } from '@/components/shell/AppShell'
import type { Fact } from '@/lib/advisor/types'
import type { BriefItem } from '@/lib/advisor/brief'
import { Chat } from './Chat'

export type Briefing = {
  day: string
  from: string
  to: string
  facts: Fact[]
  items: BriefItem[] | null
  error: string | null
  model: string | null
}

/**
 * FIGURES ARE PRINTED FROM FACTS, NEVER FROM THE MODEL'S PROSE.
 *
 * This is the second of the two places that guarantee the advisor cannot show
 * a number nobody computed — the first is validateItems() dropping an item that
 * cites an unknown fact. The model supplies the sentence; this supplies the
 * figure beside it.
 */
function figure(fact: Fact): string {
  const { current, previous, deltaPct, unit } = fact

  const one = (n: number | null) => {
    if (n === null) return '—'
    if (unit === 'money') {
      // Money is always integer minor units, currency or not — a missing
      // currency should cost the symbol, never the magnitude.
      if (!fact.currency) return (n / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })
      return (n / 100).toLocaleString(undefined, {
        style: 'currency',
        currency: fact.currency,
        maximumFractionDigits: 0,
      })
    }
    if (unit === 'percent') return `${(n * 100).toFixed(1)}%`
    if (unit === 'ratio') return n.toFixed(1)
    if (unit === 'days') return `${n} d`
    return String(n)
  }

  const move =
    deltaPct === null
      ? ''
      : // A minus sign, not just a colour: red/green colour-blindness must never
        // hide a fall. U+2212 so the sign aligns in a tabular column.
        ` (${deltaPct < 0 ? '−' : '+'}${Math.abs(deltaPct * 100).toFixed(1)}%)`

  return previous === null ? one(current) : `${one(previous)} → ${one(current)}${move}`
}

const SEVERITY_LABEL: Record<BriefItem['severity'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

function Card({ item, facts }: { item: BriefItem; facts: Fact[] }) {
  const cited = facts.filter((f) => item.factIds.includes(f.id))

  return (
    <article className="rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{item.headline}</h2>
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted">
          {SEVERITY_LABEL[item.severity]}
        </span>
      </div>

      {cited.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          {cited.map((fact) => (
            <div key={fact.id} className="text-[13px]">
              <dt className="text-muted">
                {[fact.shopName, fact.subject].filter(Boolean).join(' · ') || 'Total'}
              </dt>
              <dd className="tabular-nums text-ink">{figure(fact)}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-2 text-[13px] text-muted">{item.why}</p>
      {item.action && <p className="mt-2 text-[13px] font-medium text-ink">{item.action}</p>}
    </article>
  )
}

function FactList({ facts }: { facts: Fact[] }) {
  return (
    <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface">
      {facts.map((fact) => (
        <li key={fact.id} className="flex items-baseline justify-between gap-4 px-4 py-2 text-[13px]">
          <span className="text-muted">
            {[fact.shopName, fact.subject].filter(Boolean).join(' · ') || fact.kind}
          </span>
          <span className="tabular-nums text-ink">{figure(fact)}</span>
        </li>
      ))}
    </ul>
  )
}

export function AdvisorClient({ initial }: { initial: Briefing | null }) {
  const [briefing, setBriefing] = useState(initial)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setBusy(true)
    try {
      const res = await fetch('/api/advisor', { method: 'POST' })
      if (res.ok) setBriefing((await res.json()).briefing)
    } finally {
      setBusy(false)
    }
  }

  const subtitle = briefing ? `${briefing.from} to ${briefing.to}` : undefined

  return (
    <>
      <PageHeader title="Advisor" subtitle={subtitle}>
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Refresh'}
        </button>
      </PageHeader>

      <PageBody>
        {!briefing ? (
          <div className="rounded-[12px] border border-line bg-surface p-6">
            <p className="text-[14px] font-medium text-ink">No briefing yet</p>
            <p className="mt-1 text-[13px] text-muted">
              One is written every morning. Press Refresh to write today&rsquo;s now.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {briefing.error && (
              <div className="rounded-[12px] border border-line bg-surface p-4">
                <p className="text-[13px] font-medium text-ink">
                  The briefing could not be written: {briefing.error}
                </p>
                <p className="mt-1 text-[13px] text-muted">
                  The figures below were still computed, and are correct.
                </p>
              </div>
            )}

            {briefing.items?.length === 0 && !briefing.error && (
              <div className="rounded-[12px] border border-line bg-surface p-6">
                <p className="text-[14px] font-medium text-ink">Nothing needs your attention</p>
                <p className="mt-1 text-[13px] text-muted">
                  Nothing moved far enough this week to be worth reporting.
                </p>
              </div>
            )}

            {briefing.items?.map((item, i) => (
              <Card key={`${item.headline}-${i}`} item={item} facts={briefing.facts} />
            ))}

            {!briefing.items && briefing.facts.length > 0 && <FactList facts={briefing.facts} />}
          </div>
        )}

        <div className="mt-4">
          <Chat />
        </div>
      </PageBody>
    </>
  )
}
