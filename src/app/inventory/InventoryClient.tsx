'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Thumb } from '@/components/Thumb'
import { reorderTips, TIP_WINDOW_DAYS } from '@/lib/inventory/reorder'

export type Row = {
  sku: string
  name: string
  imageUrl: string | null
  supplierName: string | null
  stock: { quantity: number | null; disagrees: boolean; byShop: unknown[] }
  burn: number
  /** This period against the same period last year. Null = nothing to compare. */
  trend: number | null
  seasonal: boolean
  forecast: {
    runsOutOn: string | null
    /** Out of stock from `from`, covered again by an arrival on `until`. */
    gap: { from: string; until: string } | null
    /** Units on order whose date has passed with nothing received. */
    overdueArrivals: { quantity: number; since: string } | null
    orderBy: string | null
    daysLate: number | null
    quantity: number | null
    needed: number | null
    raisedBy: 'minimum' | 'container' | null
    onOrderWithoutEta: number
    note: string | null
  }
  byCountry: { country: string; units: number }[]
}

/**
 * How many suggestions the panel shows before it starts counting.
 *
 * The day lead times are first entered, EVERY product is past its order date at
 * once, and twenty suggestions above a twenty-row table is the table again. The
 * ones it drops are counted out loud below — a list that quietly stops at eight
 * reads as "that is all of them", which is the same lie as a blank cell.
 */
const MAX_TIPS = 8

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        // The forecast works in UTC days on purpose. Without this the same
        // run-out date reads a day earlier to anyone west of UTC.
        timeZone: 'UTC',
      })
    : null

/** The columns you can sort by, and the value each one reads off a row. */
const COLUMNS = {
  Product: (r: Row) => r.name.toLowerCase(),
  'In stock': (r: Row) => r.stock.quantity,
  'Per day': (r: Row) => r.burn,
  'Runs out': (r: Row) => (r.forecast.runsOutOn ? Date.parse(r.forecast.runsOutOn) : null),
  'Order by': (r: Row) => (r.forecast.orderBy ? Date.parse(r.forecast.orderBy) : null),
  'How many': (r: Row) => r.forecast.quantity,
} satisfies Record<string, (r: Row) => string | number | null>

type Column = keyof typeof COLUMNS

/**
 * Which way a first click should sort, per column.
 *
 * "Which product am I about to run out of" is answered by the SOONEST date, and
 * "which is moving fastest" by the LARGEST number. So a date opens ascending and
 * a quantity opens descending, and the first click is the useful one either way
 * rather than the one you have to click twice to undo. Product is a name, so it
 * opens A to Z.
 */
const OPENS_ASCENDING: Record<Column, boolean> = {
  Product: true,
  'In stock': false,
  'Per day': false,
  'Runs out': true,
  'Order by': true,
  'How many': false,
}

/**
 * Order rows by one column, with the unknowns pinned to the bottom.
 *
 * A null is not a zero and never sorts as one. A product whose shops report no
 * stock figure, or that has no run-out date because nothing is selling, would
 * otherwise land at the top of a highest-first list and read as the most
 * stocked thing in the warehouse — the same "say when you don't know" rule the
 * blank cells already follow. So nulls sit last in BOTH directions, which means
 * they cannot be sorted INTO the top either.
 */
function sortRows(rows: Row[], by: Column, ascending: boolean): Row[] {
  const read = COLUMNS[by]
  return [...rows].sort((a, b) => {
    const x = read(a)
    const y = read(b)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    if (x < y) return ascending ? -1 : 1
    if (x > y) return ascending ? 1 : -1
    return 0
  })
}

export function InventoryClient({
  rows,
  unusable,
  now,
}: {
  rows: Row[]
  unusable: { shopName: string; name: string; sku: string }[]
  /** Injected by tests so "already run out" is a fact, not today's date. */
  now?: string
}) {
  const today = now ? new Date(now) : new Date()

  /**
   * Nobody has filled in a single lead time yet.
   *
   * This is the state the page ships in, and it used to repeat "set lead times"
   * on every row — nineteen copies of one instruction, in the column that is
   * supposed to answer when to order. One banner says it once and links to the
   * place it gets done; the rows go quiet. As soon as any product has lead
   * times the banner disappears and only the stragglers speak up.
   */
  /**
   * What to order, lifted out of the table.
   *
   * Rebuilt from the same rows rather than passed down separately, so the panel
   * and the table can never quote different numbers for the same product. The
   * dates arrive as ISO strings because they crossed the server boundary; the
   * forecast made them and this turns them back.
   */
  const tips = reorderTips(
    rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      supplierName: r.supplierName,
      forecast: {
        orderBy: r.forecast.orderBy ? new Date(r.forecast.orderBy) : null,
        daysLate: r.forecast.daysLate,
        quantity: r.forecast.quantity,
        needed: r.forecast.needed,
        raisedBy: r.forecast.raisedBy,
      },
    })),
    today,
  )

  const missingLeadTimes = rows.some((r) => r.forecast.note === 'set lead times')
  const anySet = rows.some((r) => r.forecast.orderBy !== null || r.forecast.daysLate !== null)
  const noLeadTimesAnywhere = missingLeadTimes && !anySet

  // Null = untouched, so the server's own order stands: soonest run-out first,
  // which is the question the page exists to answer. Only a click overrides it.
  const [sort, setSort] = useState<{ by: Column; ascending: boolean } | null>(null)

  const shown = useMemo(
    () => (sort === null ? rows : sortRows(rows, sort.by, sort.ascending)),
    [rows, sort],
  )

  function toggle(by: Column) {
    setSort((s) =>
      s?.by === by ? { by, ascending: !s.ascending } : { by, ascending: OPENS_ASCENDING[by] },
    )
  }

  if (rows.length === 0 && unusable.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-line bg-surface p-5 text-[13px] text-muted">
        Nothing to forecast yet. Set a supplier and lead times under{' '}
        <span className="font-semibold text-ink">Suppliers &amp; lead times</span>, and the
        forecast fills in as soon as your shops report stock.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      {tips.length > 0 && (
        <section
          data-testid="reorder-tips"
          className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
        >
          <p className="text-[13px] font-semibold text-ink">Time to order</p>
          <p className="mt-1 text-[12px] text-muted">
            These reach their order date within {TIP_WINDOW_DAYS} days. Every quantity already
            meets the supplier&rsquo;s minimum.
          </p>

          <ul className="mt-3 space-y-2">
            {tips.slice(0, MAX_TIPS).map((t) => (
              <li
                key={t.sku}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0 text-[13px]">
                  <span className="font-medium text-ink">{t.name}</span>
                  <span className="ml-2 text-[12px] text-faint">{t.sku}</span>
                  {t.supplierName && (
                    <span className="ml-2 text-[12px] text-muted">{t.supplierName}</span>
                  )}
                  {/* Why the number is bigger than the need. Without it "order
                      800" is a figure to obey rather than one to weigh, which
                      is the opposite of a suggestion. */}
                  {t.raisedBy === 'minimum' && (
                    <div className="text-[12px] text-muted">
                      {t.needed} needed, raised to the supplier minimum
                    </div>
                  )}
                  {t.raisedBy === 'container' && (
                    <div className="text-[12px] text-muted">
                      {t.needed} needed, rounded up to a whole container
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[13px] font-semibold tabular-nums text-ink">
                    Order {t.quantity}
                  </div>
                  <div className={`text-[12px] ${t.daysLate !== null ? 'text-loss' : 'text-muted'}`}>
                    {t.daysLate !== null
                      ? `order now, ${t.daysLate} days late`
                      : t.daysUntil === 0
                        ? 'order today'
                        : `by ${when(t.orderBy.toISOString())}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {tips.length > MAX_TIPS && (
            <p className="mt-2 text-[12px] text-muted">
              and {tips.length - MAX_TIPS} more in the table below.
            </p>
          )}

          <Link
            href="/inventory/purchase-orders"
            className="mt-3 inline-block rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white"
          >
            Record a purchase order
          </Link>
        </section>
      )}

      {noLeadTimesAnywhere && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <p className="text-[13px] font-semibold text-ink">
            Run-out dates are ready. Order dates are not.
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Set production and shipping days for each product and this page can also tell you the
            date to order by, and how many units to order.
          </p>
          <Link
            href="/inventory/suppliers"
            className="mt-3 inline-block rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white"
          >
            Set lead times
          </Link>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                {(Object.keys(COLUMNS) as Column[]).map((label) => {
                  const active = sort?.by === label
                  return (
                    <th
                      key={label}
                      className="px-4 py-2.5"
                      // Announced, not merely coloured: the arrow below is
                      // decoration, this is what a screen reader reads.
                      aria-sort={
                        active ? (sort!.ascending ? 'ascending' : 'descending') : 'none'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => toggle(label)}
                        className="inline-flex items-center gap-1 font-medium transition-colors duration-150 hover:text-ink"
                      >
                        <span className={active ? 'text-ink' : undefined}>{label}</span>
                        <span aria-hidden="true" className={active ? 'text-ink' : 'text-faint'}>
                          {active ? (sort!.ascending ? '↑' : '↓') : '↕'}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Thumb src={r.imageUrl} alt={r.name} />
                      <div className="min-w-0">
                        <span className="font-medium text-ink" data-testid="forecast-name">
                          {r.name}
                        </span>
                        <span className="ml-2 text-[12px] text-faint">{r.sku}</span>
                        {!r.seasonal && (
                          <span className="ml-2 text-[11px] text-muted">
                            no seasonal history yet
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.stock.quantity === 0 ? (
                      // Zero is the one figure on this page worth interrupting
                      // someone for, and it used to look like any other number.
                      <span className="font-semibold text-loss">Out of stock</span>
                    ) : (
                      (r.stock.quantity ?? '—')
                    )}
                    {r.stock.disagrees && (
                      <span className="ml-2 text-[11px] text-warn">
                        shops disagree
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    <div>{r.burn.toFixed(1)}</div>
                    {/* The growth the forecast is already applying, said out
                        loud. The run-out dates rest on this comparison with
                        last year, and nothing else on the page admits to
                        making it. U+2212, matching the rest of the product:
                        a hyphen is narrower than a digit. */}
                    {r.trend !== null && (
                      <div className="text-[11px] text-muted">
                        {r.trend < 0 ? '−' : '+'}
                        {Math.abs(r.trend * 100).toFixed(0)}% vs last year
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.forecast.runsOutOn ? (
                      <span
                        className={
                          Date.parse(r.forecast.runsOutOn) <= today.getTime() ? 'text-loss' : ''
                        }
                      >
                        {when(r.forecast.runsOutOn)}
                      </span>
                    ) : (
                      <span className="text-muted">{r.forecast.note}</span>
                    )}
                    {/* The stockout an arrival heals. Without this line a shelf
                        that is empty TODAY with a container booked reads as "no
                        risk within a year", which is true of the year and false
                        of the fortnight the reader is standing in. */}
                    {r.forecast.gap && (
                      <div
                        className={`text-[11px] ${
                          Date.parse(r.forecast.gap.from) <= today.getTime() ? 'text-loss' : 'text-muted'
                        }`}
                      >
                        out of stock until {when(r.forecast.gap.until)}
                      </div>
                    )}
                    {/* Goods past their date that nobody has received: neither
                        counted as stock nor silently dropped. A person chases
                        the supplier, not a new order. */}
                    {r.forecast.overdueArrivals && (
                      <div className="text-[11px] text-warn">
                        {r.forecast.overdueArrivals.quantity} on order, overdue since{' '}
                        {when(r.forecast.overdueArrivals.since)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.forecast.daysLate !== null ? (
                      <span className="text-loss">
                        order now, {r.forecast.daysLate} days late
                      </span>
                    ) : r.forecast.orderBy ? (
                      when(r.forecast.orderBy)
                    ) : r.forecast.runsOutOn ? (
                      // A run-out date but no order-by date means the lead times
                      // are missing. When EVERY row is in that state the banner
                      // above has already said so, and repeating it here once per
                      // product is nineteen copies of one instruction. When only
                      // some rows lack them, this is the only place that says
                      // which — so it speaks up, and as a link rather than as
                      // dead text you cannot act on.
                      noLeadTimesAnywhere ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <Link
                          href="/inventory/suppliers"
                          className="text-warn underline-offset-2 hover:underline"
                        >
                          {r.forecast.note ?? 'set lead times'}
                        </Link>
                      )
                    ) : (
                      // The reason already appears in the "Runs out" cell one
                      // column left; repeating it here would just be noise.
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.forecast.quantity ?? '—'}
                    {r.forecast.onOrderWithoutEta > 0 && (
                      <span className="ml-2 text-[11px] text-muted">
                        {r.forecast.onOrderWithoutEta} on order, no ETA
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unusable.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <p className="text-[13px] font-semibold text-ink">
            {unusable.length} product{unusable.length === 1 ? '' : 's'} needs a SKU before it can be
            forecast
          </p>
          <p className="mt-1 text-[12px] text-muted">
            These share a SKU that cannot identify a product, so their sales cannot be pooled
            safely. Give each one its own SKU in the webshop.
          </p>
          <ul className="mt-3 space-y-1 text-[12px] text-muted">
            {unusable.map((u, i) => (
              <li key={`${u.shopName}-${u.sku}-${i}`}>
                <span className="text-ink">{u.name}</span> — {u.shopName}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
