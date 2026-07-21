'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { ACTIVE_GATEWAY, GATEWAYS } from '@/lib/gateways'

const INPUT =
  'w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint disabled:opacity-50'

type Row = { percent: string; fixed: string; noFees: boolean; cross: string; showCross: boolean }
type FeeDto = {
  gateway: string
  percent: number
  fixed: number
  noFeesApply: boolean
  crossBorderPercent: number | null
}

const emptyRow = (): Row => ({ percent: '', fixed: '', noFees: false, cross: '', showCross: false })
const blankRows = () =>
  Object.fromEntries(GATEWAYS.map((g) => [g, emptyRow()])) as Record<string, Row>

export function ProcessingFeesClient({ email }: { email: string }) {
  const toast = useToast()
  const [rows, setRows] = useState<Record<string, Row>>(blankRows)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/processing-fee')
      .then(async (r) => {
        const fees = r.ok ? ((await r.json()) as { fees: FeeDto[] }).fees : []
        if (!alive || fees.length === 0) return
        setRows((prev) => {
          const next = { ...prev }
          for (const f of fees) {
            if (!next[f.gateway]) continue
            next[f.gateway] = {
              percent: f.percent ? String(f.percent) : '',
              fixed: f.fixed ? String(f.fixed) : '',
              noFees: f.noFeesApply,
              cross: f.crossBorderPercent != null ? String(f.crossBorderPercent) : '',
              showCross: f.crossBorderPercent != null,
            }
          }
          return next
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const patch = (g: string, p: Partial<Row>) =>
    setRows((r) => ({ ...r, [g]: { ...r[g], ...p } }))

  async function save() {
    setBusy(true)
    try {
      const gateways = GATEWAYS.map((g) => {
        const row = rows[g]
        return {
          gateway: g,
          percent: Number(row.percent) || 0,
          fixed: Number(row.fixed) || 0,
          noFeesApply: row.noFees,
          crossBorderPercent: row.cross === '' ? null : Number(row.cross) || 0,
        }
      })
      const res = await fetch('/api/processing-fee', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateways }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the fees')
        return
      }
      toast.success('Fees saved. The Dintero Checkout rate applies across all webshops.')
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
        <section className="max-w-4xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
          <h2 className="text-[15px] font-bold text-ink">
            Are you using any external payment gateways?
          </h2>
          <p className="mt-0.5 text-[12px] text-muted">
            Provide the <strong>per-transaction</strong> fee rates you pay. Every gateway saves;
            orders are charged through {ACTIVE_GATEWAY} today, so its rate is the one applied
            across all webshops.
          </p>

          <div className="mt-5 space-y-6">
            {GATEWAYS.map((g) => {
              const row = rows[g]
              return (
                <div key={g} className="grid items-start gap-4 sm:grid-cols-[7.5rem_1fr_1fr_auto]">
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
                      disabled={row.noFees}
                      value={row.percent}
                      onChange={(e) => patch(g, { percent: e.target.value })}
                      className={`mt-1 ${INPUT}`}
                    />
                    <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
                      <input
                        type="checkbox"
                        aria-label={`${g} no fees apply`}
                        checked={row.noFees}
                        onChange={() => patch(g, { noFees: !row.noFees })}
                        className="h-3.5 w-3.5"
                      />
                      No fees apply
                    </label>
                  </div>

                  <div>
                    <label htmlFor={`${g}-fixed`} className="block text-[11px] font-medium text-muted">
                      Fixed Fee (EUR)
                    </label>
                    <input
                      id={`${g}-fixed`}
                      aria-label={`${g} Fixed Fee (EUR)`}
                      type="number"
                      min="0"
                      step="0.01"
                      disabled={row.noFees}
                      value={row.fixed}
                      onChange={(e) => patch(g, { fixed: e.target.value })}
                      className={`mt-1 ${INPUT}`}
                    />
                    <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
                      <input
                        type="checkbox"
                        aria-label={`${g} no fees apply`}
                        checked={row.noFees}
                        onChange={() => patch(g, { noFees: !row.noFees })}
                        className="h-3.5 w-3.5"
                      />
                      No fees apply
                    </label>
                  </div>

                  <div className={row.showCross ? '' : 'sm:pt-6'}>
                    {row.showCross ? (
                      <div>
                        <label
                          htmlFor={`${g}-cross`}
                          className="block whitespace-nowrap text-[11px] font-medium text-muted"
                        >
                          Cross border fee %
                        </label>
                        <input
                          id={`${g}-cross`}
                          aria-label={`${g} cross border fee %`}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="%"
                          disabled={row.noFees}
                          value={row.cross}
                          onChange={(e) => patch(g, { cross: e.target.value })}
                          className={`mt-1 ${INPUT} sm:w-28`}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${g} add cross border fee`}
                        onClick={() => patch(g, { showCross: true })}
                        className="whitespace-nowrap text-[12px] font-medium text-accent underline decoration-dashed underline-offset-4 hover:opacity-80"
                      >
                        + Cross border fee
                      </button>
                    )}
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
              {busy ? 'Saving…' : 'Save fees'}
            </button>
          </div>
        </section>
      </PageBody>
    </AppShell>
  )
}
