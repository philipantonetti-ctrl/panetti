'use client'

import { useState } from 'react'
import { toMinor } from '@/lib/money'
import type { CarrierAverage } from '@/lib/delivery/carrier-cost'

export type CarrierMonth = {
  carrier: string
  /** 'YYYY-MM'. */
  month: string
  parcels: number
  /** Minor units, or null when no invoice has been entered for this month. */
  amount: number | null
  currency: string | null
  /** 'bring' when nobody typed it: it was read from Bring's invoice archive. */
  source?: string | null
}

export type CarrierCostSave = {
  carrier: string
  month: string
  /** Minor units, or null to clear the month. */
  amount: number | null
  currency: string
}

const DASH = '—'

/** 'BRING' -> 'Bring'. The carrier shouts in the database, not on the page. */
const carrierName = (c: string) => c.charAt(0) + c.slice(1).toLowerCase()

/** '2026-07' -> 'July 2026'. */
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

const money = (minor: number, currency: string) =>
  (minor / 100).toLocaleString('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  })

/** Minor units as a plain editable number: 2000050 -> "20000.50". */
const editable = (minor: number | null) => (minor === null ? '' : (minor / 100).toFixed(2))

/**
 * What one parcel costs to send, per carrier.
 *
 * The money is TYPED IN, and the panel says so out loud. Neither carrier API we
 * can reach returns it: the tracking endpoints report where a parcel is, and
 * the rating endpoints would answer with a quote computed from weight and
 * dimensions we do not store — a quote that drifts from the invoice on every
 * fuel surcharge and remote-area fee. So the invoice is the input and the
 * parcels, which we do count exactly, are the divisor.
 *
 * A month with parcels but no invoice is left out of the average and NAMED.
 * Silently including its parcels would divide one month's invoice by two
 * months of parcels and report a saving nobody made; silently dropping it
 * would leave the reader to divide what they can see and get a different
 * answer from the one on screen.
 */
export function CarrierCosts({
  carriers,
  months,
  defaultCurrency,
  onSave,
}: {
  carriers: CarrierAverage[]
  months: CarrierMonth[]
  defaultCurrency: string
  onSave: (save: CarrierCostSave) => void
}) {
  if (carriers.length === 0) return null

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
      <h2 className="text-[15px] font-semibold text-ink">Cost per parcel</h2>
      {/* Two short lines, both answering a question the reader will otherwise
          ask: why am I typing this in, and why does the shop filter not change
          it. Longer explanations were tried and read as an essay above a
          four-column table. */}
      <p className="mt-1 text-[12px] text-muted">
        Enter each carrier&rsquo;s monthly invoice below and we divide it by the parcels they
        carried. Bring and DHL only tell us where a parcel is, never what it cost.
      </p>
      <p className="mt-0.5 text-[12px] text-muted">
        Covers all shops, even if you filter by one shop above. One invoice covers them all.
      </p>

      <div className="mt-4 flex flex-col gap-5">
        {carriers.map((c) => (
          <Carrier
            key={c.carrier}
            average={c}
            months={months.filter((m) => m.carrier === c.carrier)}
            defaultCurrency={defaultCurrency}
            onSave={onSave}
          />
        ))}
      </div>
    </section>
  )
}

function Carrier({
  average,
  months,
  defaultCurrency,
  onSave,
}: {
  average: CarrierAverage
  months: CarrierMonth[]
  defaultCurrency: string
  onSave: (save: CarrierCostSave) => void
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] font-semibold text-ink">{carrierName(average.carrier)}</span>
        <span className="num text-[18px] font-semibold text-ink">
          {average.averageMinor !== null && average.currency
            ? money(average.averageMinor, average.currency)
            : DASH}
        </span>
      </div>

      <p className="mt-0.5 text-[12px] text-muted">{why(average)}</p>

      <table className="mt-2 w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-[11px] font-semibold text-faint">
            <th className="py-1.5 text-left">Month</th>
            <th className="py-1.5 text-right">Parcels</th>
            <th className="py-1.5 text-right">Invoiced</th>
            <th className="py-1.5 text-right">Per parcel</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <MonthRow
              key={m.month}
              row={m}
              defaultCurrency={defaultCurrency}
              onSave={onSave}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The line under each carrier's figure, in the plainest words that are still
 * true. It always says which months the figure covers, because a cost per
 * parcel with no period attached is not a fact anyone can check.
 */
function why(a: CarrierAverage): string {
  if (a.mixedCurrency) {
    return 'Invoices are in different currencies, so they cannot be added together.'
  }

  if (a.averageMinor === null) {
    if (a.parcelsInRange === 0) return 'No parcels in this period.'
    return `${a.parcelsInRange.toLocaleString('en-GB')} parcels. Enter an invoice below to see the cost.`
  }

  const counted = `${a.shipments.toLocaleString('en-GB')} parcels in ${a.monthsCounted
    .map(monthName)
    .join(' and ')}`

  if (a.monthsMissingCost.length === 0) return counted

  // The gap, said out loud. Without it the reader divides the invoice by every
  // parcel on screen and gets a lower number than the one above.
  return `${counted}. ${a.monthsMissingCost.map(monthName).join(' and ')} not counted, no invoice yet.`
}

function MonthRow({
  row,
  defaultCurrency,
  onSave,
}: {
  row: CarrierMonth
  defaultCurrency: string
  onSave: (save: CarrierCostSave) => void
}) {
  const [text, setText] = useState(editable(row.amount))
  const currency = row.currency ?? defaultCurrency

  // Saved on blur rather than on every keystroke: a PUT per character would
  // write "2", "20", "200" over the top of each other on the way to 2000.
  function commit() {
    const trimmed = text.trim()
    // Cleared means "we do not know", which is not the same claim as a stored
    // zero, so it deletes the row rather than writing one.
    const amount = trimmed === '' ? null : toMinor(trimmed)
    if (amount === row.amount) return
    onSave({ carrier: row.carrier, month: row.month, amount, currency })
  }

  const perParcel =
    row.amount !== null && row.parcels > 0 ? Math.round(row.amount / row.parcels) : null

  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="py-1.5 text-ink">{monthName(row.month)}</td>
      <td className="num py-1.5 text-right text-muted">{row.parcels.toLocaleString('en-GB')}</td>
      <td className="py-1.5 text-right">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Invoice for ${monthName(row.month)}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          placeholder={currency}
          className="num w-28 rounded-[var(--radius-control)] border border-line bg-panel px-2 py-1 text-right text-[13px] text-ink"
        />
        {/* A figure nobody typed has to say where it came from, or it reads as
            something the reader forgot doing. Still editable: typing over it
            marks the month as his and the importer stops touching it. */}
        {row.source === 'bring' && (
          <span className="ml-2 text-[11px] text-faint">from Bring</span>
        )}
      </td>
      <td className="num py-1.5 text-right text-muted">
        {perParcel === null ? DASH : money(perParcel, currency)}
      </td>
    </tr>
  )
}
