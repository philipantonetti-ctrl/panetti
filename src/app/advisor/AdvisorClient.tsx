'use client'

import { useState } from 'react'
import Link from 'next/link'
import { PageBody, PageHeader } from '@/components/shell/AppShell'
import { isQuality, type Fact, type FactKind } from '@/lib/advisor/types'
import type { BriefItem } from '@/lib/advisor/brief'

export type Briefing = {
  day: string
  /** When this row was written. A briefing is only as current as its cron run. */
  writtenAt: string | null
  from: string
  to: string
  facts: Fact[]
  items: BriefItem[] | null
  error: string | null
  model: string | null
}

/**
 * What the window means, in words.
 *
 * "2026-08-04 to 2026-08-10" is the machine's way of putting it, and it says
 * nothing about the thing every row on this page is actually doing: comparing
 * that week against the one before. Without that sentence the arrow in
 * "NOK 52,442 → NOK 3,321" is an unexplained convention.
 */
function windowSentence(from: string, to: string): string {
  const end = new Date(`${to}T00:00:00Z`)
  const start = new Date(`${from}T00:00:00Z`)
  if (Number.isNaN(end.getTime()) || Number.isNaN(start.getTime())) return `${from} to ${to}`

  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })

  return `${day(start)} to ${day(end)}, against the ${days} days before`
}

/**
 * How old this briefing is, in words.
 *
 * One is written every morning, so an old one means the cron stopped rather
 * than that nothing happened. Without this the page reads exactly the same on
 * the morning it was written and three days later, and the figures beneath it
 * would be quietly describing a week that has since moved on.
 */
function writtenAgo(writtenAt: string | null): string | null {
  if (!writtenAt) return null
  const then = new Date(writtenAt)
  if (Number.isNaN(then.getTime())) return null

  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000)
  if (days <= 0) return 'Written today'
  if (days === 1) return 'Written yesterday'
  return `Written ${days} days ago`
}

/**
 * A failed briefing, said as something to do rather than something that broke.
 *
 * The error text is a line of status codes and a request id - it answers "what
 * broke" for whoever can trace it, and nothing at all for the person this page
 * is written for. He needs two things: that the figures below still stand, and
 * whether anything is his to fix. So the sentence leads, and the technical line
 * moves out of it (rendered separately, and only where it can help).
 *
 * A missing key is the one case Refresh cannot cure - no amount of pressing it
 * conjures an environment variable - so that case is the exception and says
 * what is actually wrong instead.
 */
const MISSING_KEY = 'ANTHROPIC_API_KEY'

function failureSentence(error: string): string {
  if (error.includes(MISSING_KEY)) {
    return 'No written summary yet: the advisor has not been given its API key.'
  }
  return 'No written summary this morning. Press Refresh to try again now, or it will be written with tomorrow morning’s run.'
}

/**
 * Where a trust warning gets fixed.
 *
 * A warning that names a problem and not its remedy leaves the reader to go
 * hunting. Missing rates are the honest exception: they arrive from the rate
 * provider on their own, and no page of ours can hurry them, so pointing
 * somewhere would be worse than pointing nowhere.
 */
const FIX: Partial<Record<FactKind, { href: string; label: string }>> = {
  UNCOSTED_PRODUCTS: { href: '/settings/costs', label: 'Enter the cost' },
  SHOP_SYNC_FAILING: { href: '/settings/shops', label: 'Check the connection' },
}

const SEVERITY_LABEL: Record<BriefItem['severity'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

// The prompt tells the model to combine related facts into one item (see
// brief.ts), so a card routinely cites revenue + ROAS + margin for the same
// shop. Without a kind label those three lines share one identical
// shop-name caption over three different numbers, and SPEND_VS_BUDGET reads
// exactly like a period-over-period move it is not.
const FACT_LABEL: Record<FactKind, string> = {
  REVENUE_MOVE: 'Revenue',
  PROFIT_MOVE: 'Profit',
  MARGIN_MOVE: 'Margin',
  ROAS_MOVE: 'ROAS',
  SPEND_VS_BUDGET: 'Spend vs budget',
  DELIVERY_DAYS_MOVE: 'Delivery days',
  ON_TIME_MOVE: 'On-time rate',
  LATE_NOW: 'Late right now',
  PRODUCT_RATE_MOVE: 'Product sales',
  B2B_QUIET: 'Gone quiet',
  AMBASSADOR_MOVE: 'Ambassador sales',
  REORDER_DUE: 'Order due',
  UNCOSTED_PRODUCTS: 'Uncosted products',
  SHOP_SYNC_FAILING: 'Sync failing',
  MISSING_FX: 'Missing exchange rate',
}

function label(fact: Fact): string {
  return [FACT_LABEL[fact.kind], fact.shopName, fact.subject].filter(Boolean).join(' · ')
}

/** Just the movement, no shop name: the shop is already the section heading. */
function rowLabel(fact: Fact): string {
  return [FACT_LABEL[fact.kind], fact.subject].filter(Boolean).join(' · ')
}

/**
 * The percentage, on its own, as the column the eye scans down.
 *
 * It is the only figure on this page that compares across shops: NOK 226,450
 * and €5,506 cannot be read against each other, but −32.7% and −88.5% can.
 */
function delta(fact: Fact): { text: string; down: boolean } | null {
  if (fact.deltaPct === null) return null
  const down = fact.deltaPct < 0
  // A sign as well as a colour. Red/green colour-blindness must never be the
  // only thing standing between the reader and a fall.
  return { text: `${down ? '−' : '+'}${Math.abs(fact.deltaPct * 100).toFixed(1)}%`, down }
}

/** Before and after, without the delta the scan column already carries. */
function movement(fact: Fact): string {
  const { current, previous, unit } = fact

  const one = (n: number | null) => {
    if (n === null) return '-'
    if (unit === 'money') {
      if (!fact.currency) return (n / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })
      return (n / 100).toLocaleString(undefined, {
        style: 'currency',
        currency: fact.currency,
        maximumFractionDigits: 0,
      })
    }
    // U+2212, matching the delta column. A hyphen is narrower than a digit and
    // breaks the tabular alignment the whole page is read down.
    if (unit === 'percent') return `${(n * 100).toFixed(1)}%`.replace(/^-/, '−')
    if (unit === 'ratio') return n.toFixed(1).replace(/^-/, '−')
    if (unit === 'days') return `${n} d`
    return String(n)
  }

  // Every leading hyphen, including the one Intl puts before a currency CODE
  // ("-NOK 7,382"), not just before a symbol. Only figures pass through here -
  // a product name with a hyphen lives in the label, never in this string.
  const pair = previous === null ? one(current) : `${one(previous)} → ${one(current)}`
  return pair.replace(/-(?=\S)/g, '−')
}

/**
 * A data-quality fact as a sentence the owner can act on.
 *
 * These say a number cannot yet be trusted, which outranks any number that
 * merely moved - so they are lifted out of the report and stated in words.
 * The raw WooCommerce error in particular is a developer artefact: PRODUCT.md
 * is explicit that this reader is not one, and a JSON blob on his screen is
 * an unanswerable question rather than a thing to fix.
 */
function trustSentence(fact: Fact): string {
  const shop = fact.shopName ?? 'A shop'

  if (fact.kind === 'UNCOSTED_PRODUCTS') {
    const n = fact.current ?? 0
    return `${shop} has ${n} product${n === 1 ? '' : 's'} with no cost entered, so its profit reads higher than it really is.`
  }

  if (fact.kind === 'SHOP_SYNC_FAILING') {
    const status = /\b(\d{3})\b/.exec(fact.subject ?? '')?.[1]
    if (status === '403' || status === '401') {
      return `${shop} refused our connection, so its figures are stale. Its WooCommerce API key needs Read permission.`
    }
    // A 5xx is their site answering badly, not a site we failed to find. Told
    // "could not be reached", the owner goes and checks his own connection;
    // what actually needs looking at is the shop's WordPress.
    if (status?.startsWith('5')) {
      return `${shop}'s website returned an error, so its figures are stale. The shop itself needs looking at, not our connection to it.`
    }
    return `${shop} could not be reached, so its figures are stale.`
  }

  return `No exchange rate for ${fact.subject ?? 'a currency'}, so figures in it could not be converted.`
}

/**
 * Every trust warning, in words, above everything it casts doubt on.
 *
 * This band used to live inside Report - which renders ONLY when the model
 * wrote no items. So on any ordinary day it was absent, and a broken sync
 * reached the page only if the model happened to cite it, where FactLine
 * printed the raw WooCommerce error beside two empty columns. collect.ts takes
 * care never to rank a trust warning away ("never cap away a trust warning");
 * this is the render half of that promise, and it was missing.
 */
function TrustBand({ facts }: { facts: Fact[] }) {
  const quality = facts.filter(isQuality)
  if (quality.length === 0) return null

  return (
    <section className="rounded-[12px] border border-line bg-warn-soft px-4 py-3">
      <h2 className="text-[13px] font-semibold text-ink">
        Check {quality.length === 1 ? 'this' : 'these'} before trusting the figures
      </h2>
      <ul className="mt-1.5 flex flex-col gap-1">
        {quality.map((fact) => {
          const fix = FIX[fact.kind]
          return (
            <li key={fact.id} className="text-[13px] text-ink">
              {trustSentence(fact)}{' '}
              {fix && (
                <Link
                  href={fix.href}
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  {fix.label}
                </Link>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * One fact, as three aligned columns: what it is, what it went from and to,
 * and by how much.
 *
 * FIGURES ARE PRINTED FROM FACTS, NEVER FROM THE MODEL'S PROSE. This is the
 * second of the two places that guarantee the advisor cannot show a number
 * nobody computed - the first is validateItems() dropping an item that cites an
 * unknown fact. The model supplies the sentence; this supplies the figure
 * beside it.
 *
 * The percentage gets the last column to itself because it is the signal. Read
 * as the tail of a sentence - "NOK 199,194 → NOK 137,595 (−30.9%)" - a card's
 * worth of them start at six different horizontal positions and cannot be
 * compared without reading every word in between. Right-aligned in a fixed
 * column they read straight down, which is what "the number is the interface"
 * asks for.
 */
function FactLine({
  fact,
  showShop,
  className = '',
}: {
  fact: Fact
  /** False wherever a heading above has already named the shop. */
  showShop: boolean
  className?: string
}) {
  const d = delta(fact)

  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto_5.5rem] ${className}`}
    >
      <span className="text-[13px] text-ink">{showShop ? label(fact) : rowLabel(fact)}</span>
      <span className="tabular-nums text-[13px] text-muted sm:text-right">{movement(fact)}</span>
      <span
        className={`tabular-nums text-right text-[13px] font-semibold ${
          d === null ? 'text-faint' : d.down ? 'text-loss' : 'text-gain'
        }`}
      >
        {d?.text ?? '-'}
      </span>
    </div>
  )
}

function Card({ item, facts }: { item: BriefItem; facts: Fact[] }) {
  // Worst first, so the figure that earned the headline is the one read first.
  // The facts arrive in whatever order the model happened to cite them.
  // Quality facts belong in the item's reasoning and the model is right to
  // cite them - but not in this column layout. They have no from, no to and no
  // percentage, so FactLine draws them as a movement from nothing to nothing
  // and prints the raw WooCommerce error as the label. TrustBand states them.
  const cited = facts
    .filter((f) => item.factIds.includes(f.id) && !isQuality(f))
    .sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id))

  // The shop belongs on a line only when it is what tells one line from the
  // next. On a card about a single shop the headline has already said it, and
  // six repetitions of "Mazzetti Norway" are six labels to read past before
  // reaching the word that differs.
  const showShop = new Set(cited.map((f) => f.shopId)).size > 1

  return (
    <article className="rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{item.headline}</h2>
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted">
          {SEVERITY_LABEL[item.severity]}
        </span>
      </div>

      {cited.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-y-1">
          {cited.map((fact) => (
            <FactLine key={fact.id} fact={fact} showShop={showShop} />
          ))}
        </div>
      )}

      <p className="mt-3 text-[13px] text-muted">{item.why}</p>
      {item.action && <p className="mt-2 text-[13px] font-medium text-ink">{item.action}</p>}
    </article>
  )
}

/** One movement in the report, where the shop is already the group heading. */
function Row({ fact }: { fact: Fact }) {
  return <FactLine fact={fact} showShop={false} className="px-4 py-2.5" />
}

/**
 * The report, grouped by shop.
 *
 * Flat, the facts arrive ranked by severity and read as twenty unrelated
 * lines: Panetti Sweden's revenue, product and ROAS land on rows 5, 7 and 14,
 * so understanding one shop means scanning the whole page and holding four
 * numbers in your head. Grouped, each shop is one story - and because a shop
 * trades in one currency, the figures inside a group are finally comparable
 * with each other.
 *
 * Shops are ordered by their worst fact, so the shop in most trouble is read
 * first. Ambassadors belong to no single shop and get their own group, last.
 */
function Report({ facts }: { facts: Fact[] }) {
  const quality = facts.filter(isQuality)
  const moves = facts.filter((f) => !isQuality(f))

  const groups = new Map<string, { name: string; facts: Fact[] }>()
  for (const fact of moves) {
    const key = fact.shopId ?? 'none'
    const group = groups.get(key)
    if (group) group.facts.push(fact)
    else groups.set(key, { name: fact.shopName ?? 'Across all shops', facts: [fact] })
  }

  // A shop we could not read did not necessarily sell less; we simply saw less.
  // Its movements have to say so where they are read, not only in the band at
  // the top, or "revenue down 86.7%" is presented as a fact about the business
  // when it is a fact about the connection.
  const stale = new Set(
    quality.filter((f) => f.kind === 'SHOP_SYNC_FAILING').map((f) => f.shopId),
  )

  const ordered = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      name: g.name,
      facts: [...g.facts].sort((a, b) => b.severity - a.severity),
      worst: Math.max(...g.facts.map((f) => f.severity)),
    }))
    // A shop with no shopId is the cross-shop bucket; it reads as a footnote to
    // the shops above it, so it sits last however severe it is.
    .sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : b.worst - a.worst))

  const fell = moves.filter((f) => f.deltaPct !== null && f.deltaPct < 0).length

  return (
    <div className="flex flex-col gap-4">
      {/* The trust band is drawn by the page, above every section it casts
          doubt on, and no longer here - this component is one of two branches,
          so a band inside it was a band the reader saw only sometimes. */}

      {/* Counts only. Naming the biggest mover here would repeat what the
          ordering already says: the shop in most trouble is the first section. */}
      {moves.length > 0 && (
        <p className="text-[13px] text-muted">
          <span className="tabular-nums font-semibold text-ink">{moves.length}</span> movements worth
          reporting, <span className="tabular-nums font-semibold text-ink">{fell}</span> of them down.
          {/* By how much moved, not by how bad: a shop whose profit tripled is
              worth reading about too, and calling that "worst" would be a lie
              about a green figure. */}{' '}
          Shops are ordered by how much moved.
        </p>
      )}

      {/* A native disclosure, not a hand-rolled one: keyboard operation, the
          open/closed state and find-in-page all come free, and DESIGN.md asks
          for standard controls rather than our own invention for a task the
          reader already knows how to do.

          The worst shop opens by default. Seven closed rows would answer
          "which shops moved" but not "what is on fire", which is the question
          this page exists for. */}
      {ordered.map((group, i) => {
        const worst = group.facts.reduce<Fact | null>(
          (w, f) => (w === null || f.severity > w.severity ? f : w),
          null,
        )
        const d = worst ? delta(worst) : null

        return (
          <details
            key={group.key}
            open={i === 0}
            className="group overflow-hidden rounded-[12px] border border-line bg-surface"
          >
            <summary className="flex cursor-pointer list-none items-center gap-x-3 bg-panel px-4 py-2.5 hover:bg-accent-soft [&::-webkit-details-marker]:hidden">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="shrink-0 text-faint transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>

              <h2 className="text-[13px] font-semibold text-ink">{group.name}</h2>

              {stale.has(group.key) && (
                <span className="text-[12px] text-warn">Not syncing, figures are stale</span>
              )}

              {/* Closed, this line is the whole summary of the shop: how many
                  movements, and the worst of them. Open, the rows below say it
                  in full, so it steps back rather than repeating itself. */}
              <span className="ml-auto flex items-baseline gap-3 group-open:hidden">
                <span className="tabular-nums text-[12px] text-muted">
                  {group.facts.length} {group.facts.length === 1 ? 'movement' : 'movements'}
                </span>
                {d && (
                  <span
                    className={`tabular-nums text-[13px] font-semibold ${d.down ? 'text-loss' : 'text-gain'}`}
                  >
                    {d.text}
                  </span>
                )}
              </span>
            </summary>

            <div className="divide-y divide-line border-t border-line">
              {/* Once per open shop, aligned with the columns it names. The
                  arrow in "NOK 52,442 → NOK 3,321" is only obvious to someone
                  who already knows what this page does. */}
              <div className="hidden px-4 pb-1 pt-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto_5.5rem] sm:gap-x-6">
                <span />
                <span className="text-right text-[11px] font-medium tracking-wide text-faint">
                  Before → after
                </span>
                <span className="text-right text-[11px] font-medium tracking-wide text-faint">
                  Change
                </span>
              </div>
              {group.facts.map((fact) => (
                <Row key={fact.id} fact={fact} />
              ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}

export function AdvisorClient({ initial }: { initial: Briefing | null }) {
  const [briefing, setBriefing] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  async function refresh() {
    setBusy(true)
    setRefreshError(null)
    try {
      const res = await fetch('/api/advisor', { method: 'POST' })
      if (res.ok) {
        setBriefing((await res.json()).briefing)
        return
      }
      // A non-ok response (a 5xx from a collector that ran into the platform's
      // own time limit, most likely) used to leave the button re-enabling
      // with nothing said. Read whatever the route did manage to explain.
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setRefreshError(body?.error || `The refresh failed (${res.status}).`)
    } catch {
      setRefreshError('The refresh failed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const subtitle = briefing
    ? [windowSentence(briefing.from, briefing.to), writtenAgo(briefing.writtenAt)]
        .filter(Boolean)
        .join(' · ')
    : undefined

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
        {refreshError && (
          <div className="mb-4 rounded-[12px] border border-line bg-surface p-4">
            <p className="text-[13px] font-medium text-ink">Refresh failed: {refreshError}</p>
          </div>
        )}

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
                  {failureSentence(briefing.error)}
                </p>
                <p className="mt-1 text-[13px] text-muted">
                  Everything below was still computed from your own figures, and is correct.
                </p>
                {/* Small and last, but present: the request id is the only
                    handle by which a failure can be traced afterwards, and a
                    failure nobody can trace is one that gets guessed at. */}
                {!briefing.error.includes(MISSING_KEY) && (
                  <p
                    data-testid="briefing-error-detail"
                    className="mt-2 break-all text-[11px] text-faint"
                  >
                    {briefing.error}
                  </p>
                )}
              </div>
            )}

            {briefing.items?.length === 0 && briefing.facts.length === 0 && !briefing.error && (
              <div className="rounded-[12px] border border-line bg-surface p-6">
                <p className="text-[14px] font-medium text-ink">Nothing needs your attention</p>
                <p className="mt-1 text-[13px] text-muted">
                  Nothing moved far enough this week to be worth reporting.
                </p>
              </div>
            )}

            {/* Above the cards, and outside the items/report choice below:
                "check these before trusting the figures" is only any use
                before the figures, and on every day rather than some. */}
            <TrustBand facts={briefing.facts} />

            {briefing.items?.map((item, i) => (
              <Card key={`${item.headline}-${i}`} item={item} facts={briefing.facts} />
            ))}

            {/* items is [] both for a quiet week (facts also []) and for a week
                the model's items were all dropped by validateItems - the two
                are indistinguishable from items alone, so this falls back to
                the facts whenever there is nothing else on the page to show
                them, rather than only when items is strictly null. */}
            {!briefing.items?.length && briefing.facts.length > 0 && <Report facts={briefing.facts} />}
          </div>
        )}

      </PageBody>
    </>
  )
}
