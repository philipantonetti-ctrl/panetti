'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Thumb } from '@/components/Thumb'
import { daysLeft, readAgo } from '@/lib/inventory/cover'

export type StockRow = {
  sku: string
  name: string
  imageUrl: string | null
  quantity: number | null
  disagrees: boolean
  /**
   * Who the figure above belongs to. Visma is the ERP the warehouse works in
   * and wins wherever it holds the SKU; `shops` is the vote among copies, kept
   * for the ones it does not.
   */
  source: 'visma' | 'shops' | 'none'
  /** When Visma last moved that warehouse row. Null unless it decided the number. */
  countedAt: string | null
  /** Visma's physical count, shown beside the figure when the two differ. */
  onHand?: number | null
  /** True when `quantity` is Visma's "Available for Shipping". */
  forShipping?: boolean
  /** From the forecast, so this page and the Forecast tab never contradict. */
  runsOutOn: string | null
  /** Why there is no run-out date, in the forecast's own words. */
  note: string | null
  byShop: { shopName: string; quantity: number | null; updatedAt: string | null }[]
}

/** The newest reading across the shops. Null when nobody has reported one. */
function lastRead(byShop: StockRow['byShop']): Date | null {
  let newest: Date | null = null
  for (const s of byShop) {
    if (!s.updatedAt) continue
    const at = new Date(s.updatedAt)
    if (Number.isNaN(at.getTime())) continue
    if (newest === null || at > newest) newest = at
  }
  return newest
}

/**
 * How long this stock lasts, in words.
 *
 * A bare "1085" is not a decision. "36 days left" is. Zero is called out rather
 * than shown as a number, because a product that is gone is the one thing on
 * this page worth interrupting someone for.
 */
function cover(r: StockRow, now: Date) {
  // Nothing to say. The quantity slot already reads "no stock data", and saying
  // it twice in one row is noise rather than emphasis.
  if (r.quantity === null) return null
  if (r.quantity === 0) return { text: 'Out of stock', tone: 'text-loss' }
  const days = daysLeft(r.runsOutOn ? new Date(r.runsOutOn) : null, now)
  if (days === null) return { text: r.note ?? 'no run-out date', tone: 'text-muted' }
  if (days === 0) return { text: 'runs out today', tone: 'text-loss' }
  return {
    text: `${days} ${days === 1 ? 'day' : 'days'} left`,
    // A month is roughly the shortest lead time anyone here works to, so under
    // that is the point where reading this page should feel uncomfortable.
    tone: days <= 30 ? 'text-warn' : 'text-muted',
  }
}

/**
 * Sorted by what is about to hurt: gone first, then soonest to run out. A
 * disagreement is badged rather than sorted to the top - a mirror that has
 * drifted by thirteen units matters, but not more than being out of stock
 * today. Products with no run-out date sort last in both cases, because a null
 * is not a zero and must never head a list about what to worry about.
 */
function byRunOut(a: StockRow, b: StockRow): number {
  const gone = Number(b.quantity === 0) - Number(a.quantity === 0)
  if (gone !== 0) return gone
  const x = a.runsOutOn ? Date.parse(a.runsOutOn) : null
  const y = b.runsOutOn ? Date.parse(b.runsOutOn) : null
  if (x === null && y === null) return 0
  if (x === null) return 1
  if (y === null) return -1
  return x - y
}

/** "No stock data" is not a zero, so it sorts last whichever way the count runs. */
const byCount = (most: boolean) => (a: StockRow, b: StockRow): number => {
  if (a.quantity === null && b.quantity === null) return 0
  if (a.quantity === null) return 1
  if (b.quantity === null) return -1
  return most ? b.quantity - a.quantity : a.quantity - b.quantity
}

const SORTS = {
  runout: { label: 'Runs out first', compare: byRunOut },
  most: { label: 'Most in stock', compare: byCount(true) },
  least: { label: 'Least in stock', compare: byCount(false) },
  name: { label: 'Name A to Z', compare: (a: StockRow, b: StockRow) => a.name.localeCompare(b.name) },
} as const
type SortKey = keyof typeof SORTS

/**
 * Read Visma's stock now rather than at the next 15-minute sync. Only drawn
 * where Visma is connected; a failed read leaves the figures as they were.
 */
function RefreshFromVisma({ readAt, now }: { readAt: string | null; now: Date }) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')

  async function refresh() {
    setState('busy')
    try {
      const res = await fetch('/api/inventory/stock/refresh', { method: 'POST' })
      if (!res.ok) return setState('failed')
      setState('idle')
      router.refresh()
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <span>Visma read {readAgo(readAt ? new Date(readAt) : null, now)}</span>
      <button
        type="button"
        onClick={refresh}
        disabled={state === 'busy'}
        className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[12px] font-semibold text-ink disabled:opacity-50"
      >
        {state === 'busy' ? 'Reading Visma…' : 'Refresh from Visma'}
      </button>
      {state === 'failed' && (
        <span className="text-loss">Could not read Visma. The figures below are from the last read.</span>
      )}
    </div>
  )
}

/** What each shop says is on the shelf, and what that means. */
export function StockClient({
  rows,
  now,
  vismaConnected = false,
  vismaReadAt = null,
}: {
  rows: StockRow[]
  now?: string
  /** Draws the refresh button. False where no Visma credentials are set. */
  vismaConnected?: boolean
  /** When we last read Visma's stock, from the sync or a refresh. */
  vismaReadAt?: string | null
}) {
  const today = now ? new Date(now) : new Date()
  const [sortKey, setSortKey] = useState<SortKey>('runout')

  const sorted = useMemo(() => [...rows].sort(SORTS[sortKey].compare), [rows, sortKey])

  if (sorted.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        No stock reported yet. Stock arrives with the next completed sync of each shop.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
        <label className="flex items-center gap-2 text-[12px] text-muted">
          Sort by
          <select
            aria-label="Sort by"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
          >
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>{SORTS[k].label}</option>
            ))}
          </select>
        </label>
        {vismaConnected && <RefreshFromVisma readAt={vismaReadAt} now={today} />}
      </div>

      {sorted.map((r) => {
        const c = cover(r, today)
        const read = lastRead(r.byShop)
        const counted = r.countedAt ? new Date(r.countedAt) : null
        // Any shop quoting a different figure from the one shown. Deliberately
        // NOT `disagrees`, which only means the shops differ from each OTHER:
        // the common case is every shop agreeing on 976 while Visma counted
        // 991, and a page gated on `disagrees` would say nothing at all about
        // the twelve SKUs where that is exactly what happens.
        const shopsDiffer = r.byShop.some((s) => s.quantity !== null && s.quantity !== r.quantity)

        return (
          <div
            key={r.sku}
            className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
          >
            <div className="flex items-start gap-3">
              <Thumb src={r.imageUrl} alt={r.name} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[13px] font-semibold text-ink" data-testid="stock-name">
                    {r.name}
                  </p>
                  <p className="text-[15px] font-semibold tabular-nums text-ink">
                    {r.quantity ?? <span className="text-[13px] text-muted">no stock data</span>}
                  </p>
                </div>

                <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-[12px] text-faint">{r.sku}</p>
                  {c && <p className={`text-[12px] ${c.tone}`}>{c.text}</p>}
                </div>

                {/* Where the number came from, always said out loud. A figure
                    with no stated origin is what made "which one is right?"
                    unanswerable before Visma was asked at all. */}
                {r.source === 'visma' ? (
                  <p className="mt-1.5 text-[11px] text-muted">
                    {/* Philip asked for "Available for Shipping" as the figure
                        (2026-10-27): on hand less what is already on a
                        shipment. On hand is kept beside it when they differ,
                        so the gap to Visma's other screen is explained. */}
                    {r.forShipping ? 'from Visma, available for shipping' : 'from Visma, on hand'}
                    {r.forShipping && r.onHand != null && r.onHand !== r.quantity && (
                      <span> · {r.onHand} on hand</span>
                    )}
                    {counted && <span> · counted {readAgo(counted, today)}</span>}
                    {shopsDiffer && <span className="text-warn"> · the shops say otherwise</span>}
                  </p>
                ) : (
                  // Nothing to say when no shop carries this product: "0 shops
                  // agree" is not a reassurance, it is a sentence with no
                  // meaning, and the figure above already reads "no stock data".
                  r.byShop.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-muted">
                      {r.disagrees ? (
                        <span className="text-warn">shops disagree</span>
                      ) : (
                        `${r.byShop.length} ${r.byShop.length === 1 ? 'shop' : 'shops'} agree`
                      )}
                      {read && <span> · read {readAgo(read, today)}</span>}
                    </p>
                  )
                )}

                {(r.disagrees || shopsDiffer) && (
                  // The odd ones out are marked rather than left to be found.
                  // Eleven shops report this product and one of them differs;
                  // reading eleven numbers to spot which is work the page can
                  // do for you.
                  <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
                    {r.byShop.map((s) => {
                      const odd = s.quantity !== r.quantity
                      return (
                        <li key={s.shopName} className={odd ? 'text-warn' : 'text-muted'}>
                          <span>{s.shopName}</span>{' '}
                          <span className={`tabular-nums ${odd ? 'font-semibold' : 'text-ink'}`}>
                            {s.quantity ?? '-'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
