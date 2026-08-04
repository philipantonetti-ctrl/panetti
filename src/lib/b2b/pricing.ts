/**
 * What a B2B order is worth.
 *
 * Pure arithmetic on integer minor units, in the CUSTOMER's currency. The field
 * names are deliberately the ones `mapOrder()` produces from WooCommerce, so an
 * order built from this lands in the database in exactly the shape the metrics
 * engine already reads — no special case anywhere downstream.
 */
import { pct, sum } from '../money'

export type DiscountKind = 'PERCENT' | 'AMOUNT'

export type B2bLine = {
  quantity: number
  /** Minor units, ex VAT, BEFORE any discount. */
  unitPrice: number
  /** 10 for "10%", or 2000 for "20.00 off each one". 0 when there is none. */
  discountValue: number
  discountKind: DiscountKind
}

export type LineTotals = { gross: number; discount: number; net: number }

/**
 * One line's worth.
 *
 * An AMOUNT discount is PER UNIT — "20.00 off each chair" — which is the frame
 * the unit price beside it on the form is already in. The discount is clamped
 * to [0, gross]: a discount reduces revenue and can never invent it, and a
 * negative one is a typo, not a surcharge.
 */
export function lineTotals(line: B2bLine): LineTotals {
  const gross = line.quantity * line.unitPrice

  const raw =
    line.discountKind === 'PERCENT'
      ? pct(gross, line.discountValue / 100)
      : line.discountValue * line.quantity

  const discount = Math.min(Math.max(raw, 0), gross)
  return { gross, discount, net: gross - discount }
}

export type OrderTotals = {
  grossSales: number
  discountTotal: number
  netSales: number
  shippingCharged: number
  taxTotal: number
  total: number
}

/**
 * The whole order.
 *
 * `vatPercent` is a percentage — 25 means 25% — and it falls on the goods and
 * the shipping alike, because shipping follows the rate of what is being
 * shipped. VAT is recorded, never counted as revenue: the engine's
 * `netRevenue` is net sales plus shipping, and `grossRevenue` adds the VAT back
 * only to say what the customer actually paid.
 */
export function orderTotals(
  lines: B2bLine[],
  shippingCharged: number,
  vatPercent: number,
): OrderTotals {
  const totals = lines.map(lineTotals)

  const grossSales = sum(totals.map((t) => t.gross))
  const discountTotal = sum(totals.map((t) => t.discount))
  const netSales = grossSales - discountTotal
  const taxTotal = pct(netSales + shippingCharged, vatPercent / 100)

  return {
    grossSales,
    discountTotal,
    netSales,
    shippingCharged,
    taxTotal,
    total: netSales + shippingCharged + taxTotal,
  }
}
