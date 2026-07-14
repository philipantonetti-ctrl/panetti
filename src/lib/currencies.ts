/**
 * Every currency in the world, for the expense amount picker.
 *
 * The codes come from the platform's own ISO list, so we don't hand-maintain one.
 */

export type Currency = {
  code: string
  symbol: string
  label: string // "USD - $", as the picker shows it
}

/** The ones we actually trade in — shown first so nobody scrolls for them. */
const COMMON = ['USD', 'EUR', 'NOK', 'SEK', 'DKK', 'GBP']

/**
 * The currencies we hold daily exchange rates for (the ECB's list, via Frankfurter).
 * An expense in anything else CANNOT be converted into the USD totals — the UI warns
 * instead of quietly counting 1 000 of it as 1 000 USD.
 */
const CONVERTIBLE = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF',
  'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN',
  'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
])

/** Used only if the platform cannot list currencies for us. */
const FALLBACK = [...COMMON, ...CONVERTIBLE]

/**
 * The default data has no distinct symbol for the Nordic currencies, so they come out
 * as "NOK - NOK". These are the symbols our shops' own finance tools use.
 */
const SYMBOL_OVERRIDES: Record<string, string> = {
  NOK: 'Nkr',
  SEK: 'Skr',
  DKK: 'Dkr',
}

/** "$" for USD, "CA$" for CAD… falling back to the code itself for anything odd. */
export function currencySymbol(code: string): string {
  if (!code) return ''
  if (SYMBOL_OVERRIDES[code]) return SYMBOL_OVERRIDES[code]

  try {
    const parts = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'symbol',
    }).formatToParts(0)

    return parts.find((p) => p.type === 'currency')?.value ?? code
  } catch {
    return code // not a real currency code — show it as typed rather than blow up
  }
}

export function isConvertible(code: string): boolean {
  return CONVERTIBLE.has(code.toUpperCase())
}

export function allCurrencies(): Currency[] {
  // Intl.supportedValuesOf is not in every TS lib target, so ask for it carefully.
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }

  let codes: string[]
  try {
    codes = intl.supportedValuesOf ? intl.supportedValuesOf('currency') : FALLBACK
  } catch {
    codes = FALLBACK
  }

  const rest = [...new Set(codes)].filter((c) => !COMMON.includes(c)).sort()

  return [...COMMON, ...rest].map((code) => {
    const symbol = currencySymbol(code)
    return { code, symbol, label: `${code} - ${symbol}` }
  })
}
