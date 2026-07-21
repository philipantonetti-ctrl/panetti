'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { formatMoney } from '@/lib/money'

type Shop = { id: string; name: string; currency: string }
type Rate = { id: string; shopId: string; perOrder: number; effectiveFrom: string }

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** Fulfillment default rates per shop, plus the one global Dintero fee. */
export function FeesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const toast = useToast()
  const [rates, setRates] = useState<Rate[]>([])
  const [busy, setBusy] = useState(false)

  // New-rate form
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [fromDate, setFromDate] = useState('')

  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    fetch('/api/fulfillment')
      .then(async (r) => {
        const rates = r.ok ? ((await r.json()) as { rates: Rate[] }).rates : null
        if (alive && rates) setRates(rates)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reload])

  async function addRate() {
    if (!shopId || !amount || !fromDate) {
      toast.error('Pick a shop, an amount and a from date')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/fulfillment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId, perOrder: Number(amount), effectiveFrom: fromDate }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the rate')
        return
      }
      toast.success('Fulfillment rate saved')
      setAmount('')
      setReload((n) => n + 1)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const currencyOf = (id: string) => shops.find((s) => s.id === id)?.currency ?? ''

  return (
    <AppShell email={email}>
      <PageHeader
        title="Fulfillment"
        subtitle="A fixed fulfillment cost per order for each shop, from the date you choose. It shows in Compare shops and reduces Net profit."
      />

      <PageBody>
        <div className="max-w-2xl">
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[13px] font-semibold text-ink">Fulfillment default rate</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Charged once per order, from the date you choose. History before that date keeps
              the rate that applied then.
            </p>

            <div className="mt-4 grid items-end gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="rate-shop" className="block text-[11px] font-medium text-muted">Shop</label>
                <select id="rate-shop" value={shopId} onChange={(e) => setShopId(e.target.value)} className={`mt-1 w-full ${INPUT}`}>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rate-amount" className="block text-[11px] font-medium text-muted">
                  Per order ({currencyOf(shopId)})
                </label>
                <input
                  id="rate-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`mt-1 w-full ${INPUT}`}
                />
              </div>
              <div>
                <label htmlFor="rate-from" className="block text-[11px] font-medium text-muted">From date</label>
                <input id="rate-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={`mt-1 w-full ${INPUT}`} />
              </div>
              <button
                onClick={addRate}
                disabled={busy}
                className="whitespace-nowrap rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save rate'}
              </button>
            </div>

            <table className="mt-4 w-full text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2 font-medium">Shop</th>
                  <th className="px-3 py-2 text-right font-medium">Per order</th>
                  <th className="px-3 py-2 text-right font-medium">From</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                {rates.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-faint">No rates yet. Orders carry no fulfillment cost until you add one.</td></tr>
                ) : (
                  rates.map((r) => (
                    <tr key={r.id} className="border-t border-line even:bg-panel/50">
                      <td className="px-3 py-2">{shops.find((s) => s.id === r.shopId)?.name ?? r.shopId}</td>
                      <td className="num px-3 py-2 text-right">{formatMoney(r.perOrder, currencyOf(r.shopId))}</td>
                      <td className="num px-3 py-2 text-right">{r.effectiveFrom.slice(0, 10)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </div>
      </PageBody>
    </AppShell>
  )
}
