/**
 * All money in this app is an INTEGER number of minor units (øre, cents).
 * Never use a float for money - 0.1 + 0.2 !== 0.3.
 * This file is the only place allowed to know about that convention.
 */

/** Round half away from zero (0.5 -> 1, -0.5 -> -1). */
function roundHalfAway(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n)
}

/** Major units (kr, $) -> integer minor units (øre, cents). */
export function toMinor(amount: number | string): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return 0
  return roundHalfAway(n * 100)
}

/** Integer minor units -> major units, for display only. */
export function toMajor(minor: number): number {
  return minor / 100
}

/**
 * Minor units -> major, keeping "nobody said" as null.
 *
 * `toMajor` is a division, and `null / 100` is 0 in JavaScript - so a nullable
 * money column read through `toMajor` silently becomes a real zero, and the
 * difference between "this cost nothing" and "nobody entered anything" is lost
 * without a word. That is not academic: `Order.fulfillmentCost` is exactly such
 * a column, and a stored zero WINS in the metrics engine, putting the order
 * permanently beyond the per-SKU shipping rates.
 *
 * Two callers made that mistake independently in one change, which is why this
 * exists rather than a null check repeated at each of them.
 */
export function toMajorOrNull(minor: number | null | undefined): number | null {
  return minor === null || minor === undefined ? null : toMajor(minor)
}

/** Multiply minor units by a rate (e.g. an FX rate), staying in whole minor units. */
export function mulRate(minor: number, rate: number): number {
  return roundHalfAway(minor * rate)
}

/** Take a percentage (0.1 = 10%) of an amount in minor units. */
export function pct(minor: number, rate: number): number {
  return roundHalfAway(minor * rate)
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

/** Format minor units for display, e.g. formatMoney(125050, 'USD') -> "$1,250.50". */
export type MoneyStyle = 'symbol-before' | 'symbol-after' | 'code-after'

// The workspace's chosen style, set once at boot from Settings. The module
// default matches the app's original look so tests stay deterministic.
let moneyStyle: MoneyStyle = 'symbol-before'

export function setMoneyStyle(style: MoneyStyle) {
  moneyStyle = style
}

/**
 * Both formatters below, with only the number of decimals between them.
 *
 * Shared rather than copied so the workspace's chosen style is decided in ONE
 * place. A second copy of this branch would be a second thing to remember when
 * a fourth style arrives, and the two would drift the first time only one was
 * updated.
 */
function format(minor: number, currency: string, digits: 0 | 2): string {
  const major = toMajor(minor)
  if (moneyStyle === 'symbol-before') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major)
  }
  // Nordic style: 1 000,00 € (symbol) or 1 000,00 EUR (code).
  return new Intl.NumberFormat('nb-NO', {
    style: 'currency',
    currency,
    currencyDisplay: moneyStyle === 'code-after' ? 'code' : 'symbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(major)
}

export function formatMoney(minor: number, currency: string): string {
  return format(minor, currency, 2)
}

/**
 * The same amount, to the krone. For the dashboard's headline figures.
 *
 * Øre are real everywhere else in this app - an order's total, a product's
 * cost, a carrier's invoice line all have to reconcile to the øre against
 * someone else's books. These four figures reconcile to nothing: they are
 * sums over a whole period, consolidated across four currencies at each
 * order's own rate. The last two digits of such a number are arithmetic, not
 * money anybody can look up, and at 32px they were wide enough to push the Net
 * Profit figure out of its card and over the one beside it.
 *
 * A separate function rather than a `decimals` flag on formatMoney, because a
 * boolean at a call site says nothing about which way it goes, and the wrong
 * way here is a figure that disagrees with the ledger by up to a krone.
 *
 * Intl ROUNDS. It does not truncate, which would make every figure quietly
 * smaller than the truth.
 */
export function formatMoneyWhole(minor: number, currency: string): string {
  return format(minor, currency, 0)
}
