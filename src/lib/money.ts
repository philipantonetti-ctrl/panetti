/**
 * All money in this app is an INTEGER number of minor units (øre, cents).
 * Never use a float for money — 0.1 + 0.2 !== 0.3.
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
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toMajor(minor))
}
