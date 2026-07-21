'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint disabled:opacity-50'

/** BeProfit's gateway list. Only Dintero Checkout is in use — the rest truthfully say "no fees apply". */
const GATEWAYS = [
  'Credit Card',
  'PayPal Account',
  'Check payments',
  'SEPA Direct Debit',
  'Vorkasse',
  'Link',
  'Cash App',
  'Pay Later',
  'Dintero Checkout',
  'Bancontact (via PayPal)',
  'Blik (via PayPal)',
]

const ACTIVE = 'Dintero Checkout'

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
      <PageHeader title="Processing Fees" />

      <PageBody>
        <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <h2 className="text-[15px] font-bold text-ink">
            Are you using any external payment gateways?
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Provide the <strong>per-transaction</strong> fee rates you pay. Only Dintero Checkout
            is in use; its fee applies across all webshops.
          </p>

          <div className="mt-5 space-y-6">
            {GATEWAYS.map((g) => {
              const live = g === ACTIVE
              return (
                <div key={g} className="grid items-start gap-4 sm:grid-cols-[7.5rem_1fr_1fr]">
                  <div className="flex h-[74px] flex-col items-center justify-center rounded-[var(--radius-card)] border border-line px-2 text-center">
                    <span aria-hidden="true" className="text-[17px]">💳</span>
                    <span className="mt-1 text-[11px] font-semibold leading-tight text-ink">{g}</span>
                  </div>

                  <div>
                    <label htmlFor={`${g}-pct`} className="block text-[11px] font-medium text-muted">
                      % of Transaction
                    </label>
                    <input
                      id={`${g}-pct`}
                      aria-label={`${g} % of Transaction`}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="%"
                      disabled={!live}
                      value={live ? percent : ''}
                      onChange={(e) => live && setPercent(e.target.value)}
                      className={`mt-1 ${INPUT}`}
                    />
                    <label className={`mt-1.5 flex items-center gap-1.5 text-[12px] ${live ? 'text-faint opacity-50' : 'text-muted'}`}>
                      <input
                        type="checkbox"
                        aria-label={`${g} no fees apply`}
                        checked={!live}
                        disabled
                        className="h-3.5 w-3.5"
                      />
                      No fees apply
                    </label>
                  </div>

                  <div>
                    <label htmlFor={`${g}-fixed`} className="block text-[11px] font-medium text-muted">
                      {live ? 'Fixed Fee (EUR)' : 'Fixed Fee'}
                    </label>
                    <input
                      id={`${g}-fixed`}
                      aria-label={`${g} ${live ? 'Fixed Fee (EUR)' : 'Fixed Fee'}`}
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={!live}
                      value={live ? fixed : ''}
                      onChange={(e) => live && setFixed(e.target.value)}
                      className={`mt-1 ${INPUT}`}
                    />
                    <label className={`mt-1.5 flex items-center gap-1.5 text-[12px] ${live ? 'text-faint opacity-50' : 'text-muted'}`}>
                      <input
                        type="checkbox"
                        aria-label={`${g} no fees apply`}
                        checked={!live}
                        disabled
                        className="h-3.5 w-3.5"
                      />
                      No fees apply
                    </label>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="mt-6 flex justify-end border-t border-line pt-4">
            <button
              onClick={save}
              disabled={busy}
              className="whitespace-nowrap rounded-[var(--radius-control)] bg-gain px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save fee'}
            </button>
          </div>
        </section>
      </PageBody>
    </AppShell>
  )
}
