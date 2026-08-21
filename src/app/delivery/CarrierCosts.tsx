'use client'

import { useState } from 'react'
import { toMinor } from '@/lib/money'
import type { CarrierAverage } from '@/lib/delivery/carrier-cost'
import { money } from '@/lib/finance/format'

export type CarrierMonth = {
  carrier: string
  /** 'YYYY-MM'. */
  month: string
  parcels: number
  /**
   * False when the month's parcel count is not the month — counting began
   * part-way through it, or never reached it at all. The bill still shows;
   * the count and the division do not. Absent means true, so a cached older
   * payload renders as it always did.
   */
  counted?: boolean
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

/**
 * 'BRING' -> 'Bring'. The carrier shouts in the database, not on the page —
 * except an acronym, which is capitals or it reads as a typo: the client's own
 * paste of this card said "Dhl".
 */
const carrierName = (c: string) => (c === 'DHL' ? 'DHL' : c.charAt(0) + c.slice(1).toLowerCase())

/**
 * '2026-09' -> 'October': the month AFTER, name only. The year would appear
 * twice in one short sentence ("early October 2026, for September 2026") and
 * the second copy says nothing the first did not.
 */
const monthAfterName = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
  return new Date(`${next}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
}

/** '2026-07' -> 'July 2026'. */
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/**
 * The finance page's own formatter, on purpose: space-grouped with the code
 * after the number, because the reader is Norwegian and both comma and dot
 * mean the decimal separator to him. A figure must not read one way on
 * /finance and another here.
 */

/** Minor units as a plain editable number: 2000050 -> "20000.50". */
const editable = (minor: number | null) => (minor === null ? '' : (minor / 100).toFixed(2))

/**
 * What one parcel costs to send, per carrier.
 *
 * Bring's monthly bill is READ FROM BRING — writeBringCosts totals the invoice
 * archive each sync and fills the month in, marked source 'bring'. DHL's is
 * TYPED, because DHL has no invoice API at all; its rating endpoints would
 * answer with a quote computed from weight and dimensions we do not store,
 * which drifts from the invoice on every fuel surcharge and remote-area fee.
 * Either way the invoice is the input and the parcels, which we count exactly,
 * are the divisor. A figure he types wins over a read one, always.
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
  firstMonth = null,
  onSave,
}: {
  carriers: CarrierAverage[]
  months: CarrierMonth[]
  defaultCurrency: string
  /** First month whose parcel count covers the whole month, or null. */
  firstMonth?: string | null
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
        The bills fill in by themselves: Bring&rsquo;s from Bring, DHL&rsquo;s from your Visma
        accounting. Nothing to type.
      </p>
      <p className="mt-0.5 text-[12px] text-muted">
        Each month&rsquo;s bill divided by that month&rsquo;s parcels. All shops together, whatever
        the filter above says.
      </p>

      <div className="mt-4 flex flex-col gap-5">
        {carriers.map((c) => (
          <Carrier
            key={c.carrier}
            average={c}
            months={months.filter((m) => m.carrier === c.carrier)}
            defaultCurrency={defaultCurrency}
            firstMonth={firstMonth}
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
  firstMonth,
  onSave,
}: {
  average: CarrierAverage
  months: CarrierMonth[]
  defaultCurrency: string
  firstMonth: string | null
  onSave: (save: CarrierCostSave) => void
}) {
  // Only complete months are table material: every cell of their row can hold
  // a real value. A month from BEFORE the record holds exactly one fact - what
  // the carrier billed - and a row that is dashes in three of four columns
  // reads as broken data however real its money is; the client pasted June and
  // July back and asked "why are there 2 months here". One fact gets one
  // sentence instead. A pre-record month with no bill has nothing at all to
  // say and is not shown.
  const rows = months.filter((m) => m.counted !== false)
  const oldBills = months
    .filter((m) => m.counted === false && m.amount !== null && m.currency !== null)
    // Oldest first: a sentence reads through time forwards, unlike the table,
    // which puts the newest month nearest the reader.
    .sort((a, b) => a.month.localeCompare(b.month))

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] font-semibold text-ink">{carrierName(average.carrier)}</span>
        {/* Money or nothing. The bare dash here was the loudest thing on a
            pending card and read as broken; the caption below already says
            when the figure comes. */}
        {average.averageMinor !== null && average.currency && (
          <span className="num text-[18px] font-semibold text-ink">
            {money(average.averageMinor, average.currency)}
          </span>
        )}
      </div>

      <p className="mt-0.5 text-[12px] text-muted">{why(average, firstMonth)}</p>
      {oldBills.length > 0 && (
        // Rows, not a sentence: six months of money in a comma-run was the
        // exact thing the client pasted back as unreadable. Month left,
        // amount right, digits aligned - the shape of every money list he
        // already uses - with one answer at the bottom.
        <div className="mt-2 max-w-[24rem]">
          <div className="text-[11px] font-semibold text-faint">
            What {carrierName(average.carrier)} billed
          </div>
          {oldBills.map((m) => (
            <div key={m.month} className="flex items-baseline justify-between py-px">
              <span className="text-[12px] text-muted">{monthName(m.month)}</span>
              <span className="num text-[13px] text-ink">{money(m.amount!, m.currency!)}</span>
            </div>
          ))}
          {oldBills.length > 1 && new Set(oldBills.map((m) => m.currency)).size === 1 && (
            <div className="mt-0.5 flex items-baseline justify-between border-t border-line pt-1">
              <span className="text-[12px] text-muted">So far</span>
              <span className="num text-[13px] font-semibold text-ink">
                {money(oldBills.reduce((n, m) => n + (m.amount ?? 0), 0), oldBills[0].currency!)}
              </span>
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (
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
            {rows.map((m) => (
              <MonthRow
                key={m.month}
                row={m}
                defaultCurrency={defaultCurrency}
                onSave={onSave}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * The line under each carrier's figure, in the plainest words that are still
 * true. It always says which months the figure covers, because a cost per
 * parcel with no period attached is not a fact anyone can check.
 */
function why(a: CarrierAverage, firstMonth: string | null): string {
  if (a.mixedCurrency) {
    return 'Invoices are in different currencies, so they cannot be added together.'
  }

  if (a.averageMinor === null) {
    if (a.parcelsInRange === 0) return 'No parcels in this period.'
    const parcels = a.parcelsInRange.toLocaleString('en-GB')
    // Before the first fully-counted month has a bill, the one thing worth
    // saying is WHEN a cost per parcel will first exist. The old captions
    // pointed at the boxes below ("enter an invoice") while every box below
    // was for a month that could not be priced - the client quoted that back
    // as the thing he could not understand.
    // One sentence, identical for both carriers: the sources are named once,
    // in the card's intro. It says when the figure ARRIVES, not which month
    // earns it first - "September will be the first month" sent the reader
    // looking in September for a number that lands with the month's last
    // bill, in early October.
    if (firstMonth) {
      return `${parcels} parcels counted. The first cost per parcel comes in early ${monthAfterName(firstMonth)}, for ${monthName(firstMonth)}.`
    }
    // No declared start to the record: the pre-tracking wording, unchanged.
    if (a.carrier === 'BRING') {
      return `${parcels} parcels. Bring's invoice fills in by itself once the month has ended.`
    }
    return `${parcels} parcels. Enter an invoice below to see the cost.`
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

  // Never for a month outside the record: its bill covers the whole month and
  // its parcel count does not, so the quotient is the one confidently wrong
  // number this card could produce.
  const perParcel =
    row.counted !== false && row.amount !== null && row.parcels > 0
      ? Math.round(row.amount / row.parcels)
      : null

  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="py-1.5 text-ink">{monthName(row.month)}</td>
      {/* A dash, not the few parcels we happened to see: printing 201 beside a
          whole-month bill invites dividing them by hand. */}
      <td className="num py-1.5 text-right text-muted">
        {row.counted === false ? DASH : row.parcels.toLocaleString('en-GB')}
      </td>
      <td className="py-1.5 text-right">
        {row.source === 'bring' || row.source === 'visma' ? (
          // A bill Bring sent is a fact to read, not a box to edit: formatted
          // as money with its label. The bare figure in an editable box was
          // the exact thing the client said he could not understand.
          <>
            <span className="num text-ink">
              {row.amount !== null && row.currency ? money(row.amount, row.currency) : DASH}
            </span>
            <span className="ml-2 text-[11px] text-faint">
              {row.source === 'visma' ? 'from Visma' : 'from Bring'}
            </span>
          </>
        ) : (
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
        )}
      </td>
      <td className="num py-1.5 text-right text-muted">
        {perParcel === null ? DASH : money(perParcel, currency)}
      </td>
    </tr>
  )
}
