'use client'

import { useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

type ShopValues = {
  id: string
  name: string
  currency: string
  wooUrl: string
  timezone: string
  defaultPreset: string
  dateFormat: string
  currencyFormat: string
  formatCountry: string
}

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink'

const DATE_FORMAT_LABELS: Record<string, string> = {
  'MMM-dd-yyyy': 'Jul-21-2026',
  'dd-MMM-yyyy': '21-Jul-2026',
  'MM/dd/yyyy': '07/21/2026',
  'dd/MM/yyyy': '21/07/2026',
  'yyyy/MM/dd': '2026/07/21',
}

const CURRENCY_FORMAT_LABELS: Record<string, string> = {
  'symbol-after': '1 000,00 €',
  'code-after': '1 000,00 EUR',
  'symbol-before': '€1,000.00',
}

const COUNTRIES = [
  'Norway', 'Sweden', 'Denmark', 'Finland', 'Germany', 'Austria', 'Belgium', 'Estonia',
  'France', 'Iceland', 'Ireland', 'Italy', 'Latvia', 'Lithuania', 'Netherlands', 'Poland',
  'Portugal', 'Spain', 'Switzerland', 'United Kingdom', 'United States',
]

function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['Europe/Oslo', 'UTC']
  } catch {
    return ['Europe/Oslo', 'UTC']
  }
}

function Select({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void
  children: React.ReactNode
}) {
  return (
    <div className="mt-4 first:mt-0">
      <label htmlFor={id} className="block text-[12px] font-medium text-ink">{label}</label>
      <select id={id} value={value} onChange={onChange} className={`mt-1 ${INPUT}`}>
        {children}
      </select>
    </div>
  )
}

/** BeProfit-style per-webshop Shop Settings — always shows the shop's actual values. */
export function ShopSettingsClient({
  email,
  shop,
  owner,
}: {
  email: string
  shop: ShopValues
  owner: string
}) {
  const toast = useToast()
  const [values, setValues] = useState({
    timezone: shop.timezone,
    defaultPreset: shop.defaultPreset,
    dateFormat: shop.dateFormat,
    currencyFormat: shop.currencyFormat,
    formatCountry: shop.formatCountry,
  })
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setValues({ ...values, [key]: e.target.value })

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/shops/${shop.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save shop settings')
        return
      }
      toast.success(`${shop.name} settings saved.`)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader title="Shop Settings" />

      <PageBody>
        <div className="max-w-2xl space-y-4">
          <section className="flex flex-wrap items-center gap-x-8 gap-y-2 rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <div>
              <p className="text-[11px] font-semibold text-faint">Shop name</p>
              <p className="text-[14px] font-semibold text-ink">{shop.name}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-faint">Shop owner</p>
              <p className="text-[13px] text-ink">{owner}</p>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-faint">Shop URL</p>
              <p className="text-[13px] text-ink">{shop.wooUrl || 'Not connected yet'}</p>
            </div>
          </section>

          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[14px] font-semibold text-ink">Standards and formats</h2>

            <div className="mt-4">
              <Select id="shop-tz" label="Time Zone" value={values.timezone} onChange={set('timezone')}>
                {timezones().map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </Select>

              <Select id="shop-preset" label="Default App Date Range" value={values.defaultPreset} onChange={set('defaultPreset')}>
                {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                  <option key={p} value={p}>{PRESET_LABELS[p]}</option>
                ))}
              </Select>

              <Select id="shop-datefmt" label="Date Format" value={values.dateFormat} onChange={set('dateFormat')}>
                {Object.entries(DATE_FORMAT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>

              <Select id="shop-country" label="Shop Format Setting" value={values.formatCountry} onChange={set('formatCountry')}>
                {COUNTRIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>

              <div className="mt-4">
                <label htmlFor="shop-currency" className="block text-[12px] font-medium text-ink">Currency</label>
                <input
                  id="shop-currency"
                  value={shop.currency}
                  disabled
                  className={`mt-1 w-24 ${INPUT} opacity-60`}
                />
                <p className="mt-1 text-[11px] text-muted">The currency comes from the store itself.</p>
              </div>

              <Select id="shop-curfmt" label="Currency Format" value={values.currencyFormat} onChange={set('currencyFormat')}>
                {Object.entries(CURRENCY_FORMAT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </div>

            <button
              onClick={save}
              disabled={busy}
              className="mt-5 rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </section>
        </div>
      </PageBody>
    </AppShell>
  )
}
