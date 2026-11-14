'use client'

import { useEffect, useState, type FormEvent } from 'react'

type View = {
  years: number[]
  year: number
  rows: { name: string; sku: string | null; months: Record<number, number>; total: number }[]
  skus: { sku: string; name: string }[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'
const fmt = (n: number) => n.toLocaleString('en-US')

/**
 * Philip's sales forecast: upload the Excel file, link each product name in it
 * to a SKU once, and the Forecast tab uses his numbers for the months he planned.
 */
export function SalesForecastClient() {
  // Which year to show (null = the latest uploaded), and a counter bumped
  // after an upload so the same year is read again.
  const [wanted, setWanted] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadYear, setUploadYear] = useState(String(new Date().getUTCFullYear()))

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`/api/inventory/plan${wanted ? `?year=${wanted}` : ''}`, { signal: ctrl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not read the sales forecast')
        setView(body as View)
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort() // a superseded response must never overwrite a newer one
  }, [wanted, reloadKey])

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const r = await fetch('/api/inventory/plan', { method: 'POST', body: form })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        setError(body?.error ?? 'Could not read the sales forecast')
        return
      }
      setMessage(
        `Read ${body.months} ${body.months === 1 ? 'month' : 'months'} and ${body.products} ${body.products === 1 ? 'product' : 'products'} for ${body.year}.`,
      )
      setWanted(body.year)
      setReloadKey((k) => k + 1)
    } catch {
      setError('Could not read the sales forecast')
    } finally {
      setBusy(false)
    }
  }

  async function link(name: string, sku: string) {
    setError('')
    const r = await fetch('/api/inventory/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, sku: sku || null }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => null)
      setError(body?.error ?? 'Could not save that link')
      return
    }
    setView((v) => (v ? { ...v, rows: v.rows.map((row) => (row.name === name ? { ...row, sku: sku || null } : row)) } : v))
  }

  const unlinked = view?.rows.filter((r) => !r.sku).length ?? 0

  return (
    <div className="space-y-4">
      <form onSubmit={upload} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">
          Year
          <input
            name="year"
            value={uploadYear}
            onChange={(e) => setUploadYear(e.target.value)}
            inputMode="numeric"
            className={`${INPUT} w-24`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">
          Sales forecast (.xlsx)
          <input name="file" type="file" accept=".xlsx" className="text-sm text-ink" />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Upload
        </button>
      </form>

      {message && <p data-testid="plan-message" className="text-sm text-ink">{message}</p>}
      {error && <p data-testid="plan-error" className="text-sm text-loss">{error}</p>}

      {view && view.years.length > 1 && (
        <div className="flex gap-1">
          {view.years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => setWanted(y)}
              aria-current={y === view.year ? 'page' : undefined}
              className={`rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] ${y === view.year ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-muted hover:bg-panel'}`}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      {view && view.rows.length === 0 && (
        <p className="text-sm text-muted">No sales forecast uploaded for {view.year} yet.</p>
      )}

      {view && view.rows.length > 0 && (
        <section className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <p data-testid="unlinked-count" className={`px-4 pt-3 text-[13px] ${unlinked > 0 ? 'text-warn' : 'text-muted'}`}>
            {unlinked > 0
              ? `${unlinked} ${unlinked === 1 ? 'product has' : 'products have'} no SKU yet. Pick one, or its forecast is not used.`
              : 'Every product is linked to a SKU.'}
          </p>
          <table className="mt-2 w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-4 py-2 font-medium">In the file</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                {MONTHS.map((m) => (
                  <th key={m} className="px-2 py-2 text-right font-medium">{m}</th>
                ))}
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.name} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-medium text-ink">{r.name}</td>
                  <td className="px-4 py-2">
                    <select
                      aria-label={`SKU for ${r.name}`}
                      value={r.sku ?? ''}
                      onChange={(e) => void link(r.name, e.target.value)}
                      className={`${INPUT} py-1`}
                    >
                      <option value="">Not linked</option>
                      {view.skus.map((s) => (
                        <option key={s.sku} value={s.sku}>
                          {s.sku} - {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  {MONTHS.map((_, i) => (
                    <td key={i} className="px-2 py-2 text-right tabular-nums">
                      {r.months[i + 1] !== undefined ? fmt(r.months[i + 1]) : ''}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
