'use client'

import { useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { PRESET_LABELS, type Preset } from '@/lib/dates'

type Values = { timezone: string; defaultPreset: string; dateFormat: string; currencyFormat: string }

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

function timezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : ['Europe/Oslo', 'UTC']
  } catch {
    return ['Europe/Oslo', 'UTC']
  }
}

export function GeneralClient({ email, initial }: { email: string; initial: Values }) {
  const toast = useToast()
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setValues({ ...values, [key]: e.target.value })

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save settings')
        return
      }
      toast.success('Settings saved. New day boundaries apply to every screen.')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="General settings"
        subtitle="Standards and formats for the whole workspace. The timezone decides when each sales day starts and ends."
      />

      <PageBody>
        <section className="max-w-md rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <label className="block text-[12px] font-medium text-ink">Time zone</label>
          <select aria-label="Time zone" value={values.timezone} onChange={set('timezone')} className={`mt-1 ${INPUT}`}>
            {timezones().map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>

          <label className="mt-4 block text-[12px] font-medium text-ink">Default date range</label>
          <select aria-label="Default date range" value={values.defaultPreset} onChange={set('defaultPreset')} className={`mt-1 ${INPUT}`}>
            {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
              <option key={p} value={p}>{PRESET_LABELS[p]}</option>
            ))}
          </select>

          <label className="mt-4 block text-[12px] font-medium text-ink">Date format</label>
          <select aria-label="Date format" value={values.dateFormat} onChange={set('dateFormat')} className={`mt-1 ${INPUT}`}>
            {Object.entries(DATE_FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <label className="mt-4 block text-[12px] font-medium text-ink">Currency format</label>
          <select aria-label="Currency format" value={values.currencyFormat} onChange={set('currencyFormat')} className={`mt-1 ${INPUT}`}>
            {Object.entries(CURRENCY_FORMAT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <button
            onClick={save}
            disabled={busy}
            className="mt-5 rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </section>
      </PageBody>
    </AppShell>
  )
}
