import { db } from './db'

/** Workspace-wide preferences: one row, sensible Nordic defaults until saved. */
export const SETTING_DEFAULTS = {
  timezone: 'Europe/Oslo',
  defaultPreset: 'this_month',
  dateFormat: 'MMM-dd-yyyy',
  currencyFormat: 'symbol-after',
}

export const DATE_FORMATS = ['MMM-dd-yyyy', 'dd-MMM-yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy', 'yyyy/MM/dd']
export const CURRENCY_FORMATS = ['symbol-after', 'code-after', 'symbol-before']

export async function getSetting() {
  const row = await db.setting.findUnique({ where: { id: 'singleton' } })
  return row ?? { id: 'singleton', ...SETTING_DEFAULTS }
}
