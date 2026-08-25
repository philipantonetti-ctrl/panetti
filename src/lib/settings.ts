import { db } from './db'

/** Workspace-wide preferences: one row, sensible Nordic defaults until saved. */
export const SETTING_DEFAULTS = {
  timezone: 'Europe/Oslo',
  defaultPreset: 'this_month',
  dateFormat: 'MMM-dd-yyyy',
  currencyFormat: 'symbol-after',
  displayCurrency: 'USD',
}

export const DATE_FORMATS = ['MMM-dd-yyyy', 'dd-MMM-yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy/MM/dd']
export const CURRENCY_FORMATS = ['symbol-after', 'code-after', 'symbol-before']

/**
 * What the workspace may consolidate into. Restricted to what the rate
 * provider (Frankfurter, see fx/rates.ts) actually quotes - an unquoted
 * currency would leave crossConvert with no rate and silently return the
 * amount unconverted, which reads as a real number and is not one.
 */
export const DISPLAY_CURRENCIES = ['USD', 'NOK', 'DKK', 'SEK', 'EUR', 'GBP']

export async function getSetting() {
  // Never fatal: build-time prerenders and DB hiccups fall back to defaults.
  try {
    const row = await db.setting.findUnique({ where: { id: 'singleton' } })
    return row ?? { id: 'singleton', ...SETTING_DEFAULTS }
  } catch {
    return { id: 'singleton', ...SETTING_DEFAULTS }
  }
}
