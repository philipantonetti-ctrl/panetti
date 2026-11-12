'use client'

import { useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { AMBASSADOR_TABS, PageTabs } from '@/components/shell/PageTabs'
import { DateFilter, type RangeChoice } from '@/components/filters/DateFilter'
import type { Preset } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import type { CodeOrder } from '@/lib/ambassadors/code-check'

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

type Result = {
  code: string
  linkedTo: { ambassador: string; shop: string }[]
  used: number
  counted: number
  orders: CodeOrder[]
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * "The shop says 15 orders on this code, the list shows 13." Type the code and
 * see every order that used it, which count, and why the others do not - the
 * answer staff used to spend hours piecing together.
 */
export function CodeCheckClient({ email, role = 'ADMIN' }: { email: string; role?: 'ADMIN' | 'MARKETING' }) {
  const [code, setCode] = useState('')
  const [preset, setPreset] = useState<Preset | 'custom'>('this_year')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(c: string, range: { preset: Preset | 'custom'; from: string; to: string }) {
    if (!c.trim()) return
    const params = new URLSearchParams({ code: c.trim() })
    if (range.preset === 'custom') {
      params.set('from', range.from)
      params.set('to', range.to)
    } else {
      params.set('preset', range.preset)
    }
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`/api/ambassadors/code-check?${params}`)
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        setResult(null)
        setError(body?.error ?? 'Could not check that code')
      } else {
        setResult(body as Result)
      }
    } catch {
      setError('Could not check that code')
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void run(code, { preset, from, to })
  }

  function pickRange(next: RangeChoice) {
    setPreset(next.preset)
    setFrom(next.from ?? '')
    setTo(next.to ?? '')
    if (result) void run(code, { preset: next.preset, from: next.from ?? '', to: next.to ?? '' })
  }

  const notCounting = result ? result.used - result.counted : 0

  return (
    <AppShell email={email} role={role}>
      <PageHeader
        title="Ambassadors"
        subtitle="Type a discount code to see every order that used it, and why each one counts or not."
      >
        <DateFilter preset={preset} from={from} to={to} onChange={pickRange} />
      </PageHeader>

      <PageTabs tabs={AMBASSADOR_TABS} />

      <PageBody>
        <form onSubmit={submit} className="mb-5 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] font-semibold text-muted">
            Discount code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. andi50"
              className={`${INPUT} w-64 uppercase`}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Check
          </button>
        </form>

        {error && <p className="mb-4 text-sm text-loss">{error}</p>}

        {result && (
          <div className="space-y-4">
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
              <p data-testid="code-summary" className="text-[15px] font-semibold text-ink">
                {result.used} orders used {result.code}. {result.counted} count
                {notCounting > 0 ? `, ${notCounting} do not.` : '.'}
              </p>
              <p data-testid="code-owner" className="mt-1 text-[13px] text-muted">
                {result.linkedTo.length > 0 ? (
                  <>
                    Belongs to{' '}
                    {result.linkedTo.map((l, i) => (
                      <span key={`${l.ambassador}-${l.shop}`}>
                        {i > 0 ? ', ' : ''}
                        <strong className="text-ink">{l.ambassador}</strong> ({l.shop})
                      </span>
                    ))}
                    . Only the orders that count earn commission.
                  </>
                ) : (
                  <span className="text-loss">
                    No ambassador has this code in Panetti, so these orders earn no commission. Add it to the
                    ambassador under Add an ambassador.
                  </span>
                )}
              </p>
              {result.orders.length < result.used && (
                <p className="mt-1 text-[12px] text-muted">Showing the newest {result.orders.length}.</p>
              )}
            </section>

            <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
                    <th className="px-5 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Order</th>
                    <th className="px-4 py-2 text-left">Shop</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-right">Sale excl. VAT</th>
                    <th className="px-5 py-2 text-left">Counts?</th>
                  </tr>
                </thead>
                <tbody>
                  {result.orders.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-12 text-center text-muted">
                        No orders used this code in this period.
                      </td>
                    </tr>
                  ) : (
                    result.orders.map((o) => (
                      <tr key={o.id} className="border-b border-line last:border-b-0">
                        <td className="num px-5 py-2.5 text-muted">{day(o.date)}</td>
                        <td className="num px-4 py-2.5 text-ink">#{o.number}</td>
                        <td className="px-4 py-2.5 text-ink">{o.shop}</td>
                        <td className="px-4 py-2.5 text-ink">{o.statusLabel}</td>
                        <td className="num px-4 py-2.5 text-right text-ink">{formatMoney(o.sales, o.currency)}</td>
                        <td className="px-5 py-2.5">
                          {o.counts ? (
                            <span className="font-semibold text-gain">Counts</span>
                          ) : (
                            <span>
                              <span className="font-semibold text-loss">Does not count</span>
                              <span className="text-muted">: {o.reason}</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
