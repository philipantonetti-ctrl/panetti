'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/toast/useToast'

/**
 * Posting Dintero payouts into the Visma TEST company. Off by default.
 * "Dry run" shows what would be sent; "Write on hold" creates the documents
 * on hold in the test company for Philip and the bookkeeper to check.
 */

type Mode = 'off' | 'dry_run' | 'hold'
type Shop = {
  shopId: string
  name: string
  currency: string
  vismaCustomer: string | null
  vismaClearingAccount: string | null
  vismaBankAccount: string | null
  vismaFeeAccount: string | null
}
const COLUMNS: { key: keyof Shop; label: string }[] = [
  { key: 'vismaCustomer', label: 'Webshop customer' },
  { key: 'vismaClearingAccount', label: 'Dintero account' },
  { key: 'vismaBankAccount', label: 'Bank account' },
  { key: 'vismaFeeAccount', label: 'Fee account' },
]
const field = 'w-24 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-sm'
const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

export function VismaPostingCard() {
  const [mode, setMode] = useState<Mode>('off')
  const [shops, setShops] = useState<Shop[]>([])
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    fetch('/api/visma-posting')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.mode || !Array.isArray(d.shops)) return
        setMode(d.mode)
        setShops(d.shops)
      })
      .catch(() => {})
  }, [])

  const edit = (shopId: string, key: keyof Shop, value: string) =>
    setShops((list) => list.map((s) => (s.shopId === shopId ? { ...s, [key]: value } : s)))

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/visma-posting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, shops }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Could not save')
      setMode(d.mode)
      setShops(d.shops)
      toast.success('Visma posting saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 className="text-base font-semibold text-ink">Visma posting (test company)</h2>
      <p className="mt-1 text-sm text-muted">
        Posts each Dintero payout into Visma as the bookkeeper&apos;s drawing describes. Writes go only to the test
        company, and every document is created on hold.
      </p>
      <label className="mt-4 block text-sm font-semibold text-ink">
        Mode{' '}
        <select
          className="ml-2 rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-sm"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="off">Off</option>
          <option value="dry_run">Dry run (send nothing)</option>
          <option value="hold">Write on hold to the test company</option>
        </select>
      </label>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-2 pr-3">Shop</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="py-2 pr-3">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shops.map((s) => (
            <tr key={s.shopId} className="border-t border-line">
              <td className="py-2 pr-3">{s.name} <span className="text-muted">{s.currency}</span></td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="py-2 pr-3">
                  <input
                    aria-label={`${s.name} ${c.label}`}
                    className={field}
                    inputMode="numeric"
                    value={(s[c.key] as string | null) ?? ''}
                    onChange={(e) => edit(s.shopId, c.key, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <button className={`${primaryBtn} mt-4`} disabled={busy} onClick={save}>
        {busy ? 'Saving' : 'Save'}
      </button>
    </section>
  )
}
