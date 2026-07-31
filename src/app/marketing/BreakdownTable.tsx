'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { formatMoney } from '@/lib/money'
import type { BreakdownRow, BreakdownResponse } from '@/lib/ads/breakdown'
import type { BreakdownLevel } from '@/lib/ads/types'

/**
 * Campaign -> ad set -> ad, one row shape at every depth, asked for live and
 * never stored (see the design doc). ROAS and CTR are never in the response —
 * carrying a derived figure beside its inputs is how two numbers on one screen
 * come to disagree — so both are computed here, once, in one helper each, and
 * every level renders through the same row.
 */

const MIDDLE_LABEL: Record<'meta' | 'google', string> = { meta: 'Ad set', google: 'Ad group' }
const PLATFORM_NAME: Record<'meta' | 'google', string> = { meta: 'Meta', google: 'Google' }

/** Depth 0 = campaign, 1 = ad set/group, 2 = ad. Literal classes: Tailwind's
 * scanner reads source text, not runtime template results. */
const INDENT = ['pl-4', 'pl-8', 'pl-12']
const CHILD_INDENT = ['pl-8', 'pl-12', 'pl-12']

const COLUMNS = 6

/** Two accounts can each own an entity with the same platform id. */
function rowKey(row: Pick<BreakdownRow, 'accountId' | 'id'>): string {
  return `${row.accountId}:${row.id}`
}

/**
 * A ratio with nothing to divide by is unknown, never a number pretending to
 * be one. Formatted to match MarketingTable.tsx's own `cellText` ('roas' and
 * 'pct' cases, and its null dash) rather than inventing a second convention —
 * this table sits on the same page, and a client should never see the same
 * ROAS labelled two different ways within one screen.
 */
function roasText(spend: number, purchaseValue: number): string {
  if (spend === 0) return '—'
  return `${(purchaseValue / spend).toFixed(2)}×`
}

function ctrText(clicks: number, impressions: number): string {
  if (impressions === 0) return '—'
  return `${((clicks / impressions) * 100).toFixed(1)}%`
}

/** Google reports fractional conversions; whole numbers stay whole. */
function purchasesText(value: number): string {
  return value % 1 === 0 ? value.toLocaleString('en-US') : value.toFixed(1)
}

function nextLevel(level: BreakdownLevel): BreakdownLevel | null {
  if (level === 'campaign') return 'adset'
  if (level === 'adset') return 'ad'
  return null
}

/** What one expansion is holding: still fetching, or the same rows/errors
 * shape the top level gets, cached forever once it arrives. */
type Expansion = { status: 'loading' | 'ready'; rows: BreakdownRow[]; errors: BreakdownResponse['errors'] }

async function readBreakdown(url: string): Promise<BreakdownResponse> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? 'Could not load the breakdown')
  }
  return res.json() as Promise<BreakdownResponse>
}

type BreakdownTableProps = { shopId: string; provider: 'meta' | 'google'; from: string; to: string }

/**
 * A campaign list belongs to one (shopId, provider, from, to) — changing any
 * of them means a different set of campaigns, so whatever was expanded and
 * cached under the old ones must not survive into the new list. Rather than
 * clearing five pieces of state by hand on every change (a synchronous
 * setState-in-effect React itself warns against — it renders the old data one
 * extra frame before wiping it, and invites exactly the kind of half-reset bug
 * where one piece of state is forgotten), the params are the React `key`: a
 * change mounts a fresh instance, which starts clean because that is what a
 * new instance means. See https://react.dev/learn/preserving-and-resetting-state.
 */
export function BreakdownTable(props: BreakdownTableProps) {
  const resetKey = [props.shopId, props.provider, props.from, props.to].join('|')
  return <BreakdownTablePanel key={resetKey} {...props} />
}

function BreakdownTablePanel({ shopId, provider, from, to }: BreakdownTableProps) {
  const [rows, setRows] = useState<BreakdownRow[] | null>(null)
  const [errors, setErrors] = useState<BreakdownResponse['errors']>([])
  const [accountsChecked, setAccountsChecked] = useState(0)
  const [loadError, setLoadError] = useState('')
  // Bumped by the retry control to re-run the load effect below without
  // duplicating its fetch/parse logic.
  const [reloadTick, setReloadTick] = useState(0)
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set())
  const [cache, setCache] = useState<Record<string, Expansion>>({})
  // A ref, not state: it must be readable synchronously inside the very click
  // that first sets it, so two fast clicks on the same row can never both
  // pass the "already fetched" check before either has set anything.
  const fetchedKeys = useRef<Set<string>>(new Set())

  useEffect(() => {
    const ctrl = new AbortController()
    const params = new URLSearchParams({ shopId, provider, level: 'campaign', from, to })
    fetch(`/api/marketing/breakdown?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error ?? 'Could not load the breakdown')
        }
        return res.json() as Promise<BreakdownResponse>
      })
      .then((json) => {
        setRows(json.rows)
        setErrors(json.errors)
        setAccountsChecked(json.accountsChecked)
        setLoadError('') // a retry that succeeds must clear the error it is retrying
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setLoadError(e.message)
      })
    return () => ctrl.abort() // a superseded response must never land after a newer one
  }, [shopId, provider, from, to, reloadTick])

  function retryLoad() {
    setLoadError('') // back to the loading state, not a stale message over a fresh spinner
    setReloadTick((n) => n + 1)
  }

  function loadChildren(row: BreakdownRow, level: BreakdownLevel, key: string) {
    setCache((prev) => ({ ...prev, [key]: { status: 'loading', rows: [], errors: [] } }))
    // A campaign/ad set id belongs to exactly one ad account — scoping the
    // child request to it is what stops a second account on the same
    // provider from being asked for the same object id (see breakdown.ts).
    const params = new URLSearchParams({
      shopId,
      provider,
      level,
      parentId: row.id,
      accountId: row.accountId,
      from,
      to,
    })
    readBreakdown(`/api/marketing/breakdown?${params}`)
      .then((json) => {
        setCache((prev) => ({ ...prev, [key]: { status: 'ready', rows: json.rows, errors: json.errors } }))
      })
      .catch((e: Error) => {
        // The request itself failing (network, non-2xx) is shown the same way
        // as a per-account failure inside a 200 — one reason, under this row.
        setCache((prev) => ({
          ...prev,
          [key]: {
            status: 'ready',
            rows: [],
            errors: [{ accountId: row.accountId, accountName: row.accountName, message: e.message }],
          },
        }))
        // A transient failure (rate limit, a brief 500, a token blip) must be
        // retryable by collapsing and re-expanding — leaving this key marked
        // "fetched" is what would make a failure permanent, the same trap
        // `toggle`'s own comment names for a successful expansion.
        fetchedKeys.current.delete(key)
      })
  }

  function toggle(row: BreakdownRow, childLevel: BreakdownLevel) {
    const key = rowKey(row)
    setOpenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (fetchedKeys.current.has(key)) return // fetched once, kept forever
    fetchedKeys.current.add(key)
    loadChildren(row, childLevel, key)
  }

  function renderRow(row: BreakdownRow, level: BreakdownLevel, depth: number) {
    const key = rowKey(row)
    const childLevel = nextLevel(level)
    const isOpen = openKeys.has(key)
    const child = cache[key]
    const indent = INDENT[depth] ?? INDENT[INDENT.length - 1]
    const childIndent = CHILD_INDENT[depth] ?? CHILD_INDENT[CHILD_INDENT.length - 1]

    return (
      <Fragment key={key}>
        <tr
          className={`border-b border-line last:border-0 ${childLevel ? 'cursor-pointer hover:bg-panel' : ''}`}
          onClick={childLevel ? () => toggle(row, childLevel) : undefined}
        >
          <td className={`${indent} py-2 pr-4`}>
            {childLevel ? (
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(row, childLevel)
                }}
                className="flex items-center gap-1.5 text-left text-[13px] font-medium text-ink"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block w-3 text-faint transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                >
                  ›
                </span>
                {row.name}
              </button>
            ) : (
              <span className="block pl-[18px] text-[13px] text-ink">{row.name}</span>
            )}
          </td>
          <td className="num px-4 py-2 text-right text-[13px] text-ink">{formatMoney(row.spend, row.currency)}</td>
          <td className="num px-4 py-2 text-right text-[13px] text-ink">{roasText(row.spend, row.purchaseValue)}</td>
          <td className="num px-4 py-2 text-right text-[13px] text-ink">{purchasesText(row.purchases)}</td>
          <td className="num px-4 py-2 text-right text-[13px] text-ink">
            {formatMoney(row.purchaseValue, row.currency)}
          </td>
          <td className="num px-4 py-2 text-right text-[13px] text-ink">{ctrText(row.clicks, row.impressions)}</td>
        </tr>

        {childLevel && isOpen && (!child || child.status === 'loading') && (
          <tr>
            <td colSpan={COLUMNS} className={`${childIndent} py-2 text-[12px] text-muted`}>
              Loading…
            </td>
          </tr>
        )}

        {childLevel && isOpen && child?.status === 'ready' && level === 'campaign' && (
          <tr>
            <td colSpan={COLUMNS} className={`${childIndent} pt-2 text-[11px] font-semibold tracking-wide text-faint`}>
              {MIDDLE_LABEL[provider]}
            </td>
          </tr>
        )}

        {childLevel &&
          isOpen &&
          child?.status === 'ready' &&
          child.rows.map((c) => renderRow(c, childLevel, depth + 1))}

        {childLevel &&
          isOpen &&
          child?.status === 'ready' &&
          child.errors.map((err, i) => (
            <tr key={`${key}:err:${i}`}>
              <td colSpan={COLUMNS} className={`${childIndent} py-2 text-[12px] text-loss`}>
                {err.accountName}: {err.message}
              </td>
            </tr>
          ))}
      </Fragment>
    )
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <p className="border-b border-line px-5 py-2.5 text-[12px] text-muted">
        Live from {PLATFORM_NAME[provider]}, in the ad account’s own currency.
      </p>

      {loadError && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 text-[13px] text-loss">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={retryLoad}
            className="shrink-0 rounded-[var(--radius-control)] border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink transition-colors duration-150 hover:border-faint"
          >
            Try again
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="space-y-1 border-b border-line px-5 py-3 text-[13px] text-loss">
          {errors.map((e) => (
            <p key={e.accountId}>
              {e.accountName}: {e.message}
            </p>
          ))}
        </div>
      )}

      {rows === null ? (
        // A failed initial load must not sit under its own "Loading…" — the
        // banner above already says what happened, and Try again is the
        // only next step, not a spinner that was never going to resolve.
        loadError ? null : (
          <p className="px-5 py-8 text-center text-[13px] text-muted">Loading campaigns…</p>
        )
      ) : accountsChecked === 0 ? (
        // Nothing connected, not merely nothing spent — a different sentence
        // from the one below, checked first so it wins when both are empty.
        <p className="px-5 py-8 text-center text-[13px] text-muted">
          No {PLATFORM_NAME[provider]} ad accounts on this store yet.
        </p>
      ) : errors.length > 0 && rows.length === 0 ? (
        // Not "nothing ran" — that is not something we actually know here.
        // Every account that could have said so failed; its reason is in
        // the banner above, not a claim about the client's own money.
        <p className="px-5 py-8 text-center text-[13px] text-muted">Could not read this period.</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">No campaigns ran in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel text-left text-[11px] font-semibold text-faint">
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2 text-right">Spend</th>
                <th className="px-4 py-2 text-right">ROAS</th>
                <th className="px-4 py-2 text-right">Purch.</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="px-4 py-2 text-right">CTR</th>
              </tr>
            </thead>
            <tbody>{rows.map((r) => renderRow(r, 'campaign', 0))}</tbody>
          </table>
        </div>
      )}
    </section>
  )
}
