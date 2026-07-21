'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** One gateway card, BeProfit-style — Dintero Checkout is the only one we use. */
export function ProcessingFeesClient({ email }: { email: string }) {
  const toast = useToast()
  const [percent, setPercent] = useState('')
  const [fixed, setFixed] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/processing-fee')
      .then(async (r) => {
        const fee = r.ok
          ? ((await r.json()) as { fee: { percent: number; fixed: number } | null }).fee
          : null
        if (!alive || !fee) return
        setPercent(String(fee.percent))
        setFixed(String(fee.fixed))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/processing-fee', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ percent: Number(percent) || 0, fixed: Number(fixed) || 0 }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the fee')
        return
      }
      toast.success('Processing fee saved. It applies across all webshops.')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Processing Fees"
        subtitle="The per-transaction fee your payment gateway takes. It applies across all webshops and reduces Net profit."
      />

      <PageBody>
        <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <h2 className="text-[14px] font-semibold text-ink">
            Are you using any external payment gateways?
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Provide the per-transaction fee rates you pay. The percent applies to the charged
            amount; the fixed part is in EUR and converts at each order&apos;s own exchange rate.
          </p>

          <div className="mt-5 grid items-end gap-4 sm:grid-cols-[8rem_10rem_10rem_auto]">
            <div className="flex h-[72px] flex-col items-center justify-center rounded-[var(--radius-card)] border border-line bg-panel px-2 text-center">
              <span aria-hidden="true" className="text-[18px]">💳</span>
              <span className="mt-1 text-[11px] font-semibold text-ink">Dintero Checkout</span>
            </div>

            <div>
              <label htmlFor="dintero-percent" className="block text-[11px] font-medium text-muted">
                % of Transaction
              </label>
              <input
                id="dintero-percent"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.6"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                className={`mt-1 ${INPUT}`}
              />
            </div>

            <div>
              <label htmlFor="dintero-fixed" className="block text-[11px] font-medium text-muted">
                Fixed Fee (EUR)
              </label>
              <input
                id="dintero-fixed"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.10"
                value={fixed}
                onChange={(e) => setFixed(e.target.value)}
                className={`mt-1 ${INPUT}`}
              />
            </div>

            <button
              onClick={save}
              disabled={busy}
              className="justify-self-start whitespace-nowrap rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save fee'}
            </button>
          </div>
        </section>
      </PageBody>
    </AppShell>
  )
}
