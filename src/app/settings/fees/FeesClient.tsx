'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import { formatMoney } from '@/lib/money'

type Shop = { id: string; name: string; currency: string }
type Rate = { id: string; shopId: string; perOrder: number; effectiveFrom: string }
type Step = 'list' | 'method' | 'rates'

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/** The methods BeProfit offers; only Default Rate is live in this phase. */
const LATER_METHODS = [
  { name: 'Order Weight', blurb: 'Shipping rates based on order weight tiers' },
  { name: 'Order Quantity', blurb: 'Shipping rates based on order quantity tiers' },
  { name: 'Order Price', blurb: 'Shipping rates based on order price tiers' },
  { name: 'Shipping Carrier', blurb: 'Rates from keywords in your carrier titles' },
  { name: 'Shipping Title', blurb: 'Rates from keywords in your shipping method titles' },
  { name: 'Other', blurb: 'More conditions to calculate your shipping costs by' },
]

/**
 * BeProfit-shaped flow, default-rate engine underneath:
 * rules list -> Create New Rule -> profile methods -> Edit -> rates -> Save.
 */
export function FeesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const toast = useToast()
  const [step, setStep] = useState<Step>('list')
  const [rates, setRates] = useState<Rate[]>([])
  const [busy, setBusy] = useState(false)

  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [fromDate, setFromDate] = useState('')

  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    fetch('/api/fulfillment')
      .then(async (r) => {
        const loaded = r.ok ? ((await r.json()) as { rates: Rate[] }).rates : null
        if (alive && loaded) setRates(loaded)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reload])

  const currencyOf = (id: string) => shops.find((s) => s.id === id)?.currency ?? ''

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
      setStep('list')
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const title = step === 'list' ? 'Fulfillment' : 'Create Fulfillment Profile'

  return (
    <AppShell email={email}>
      <PageHeader
        title={title}
        subtitle={
          step === 'list'
            ? 'A fixed fulfillment cost per order for each shop. It shows in Compare shops and reduces Net profit.'
            : undefined
        }
      >
        {step !== 'list' && (
          <button
            onClick={() => setStep(step === 'rates' ? 'method' : 'list')}
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink hover:bg-panel"
          >
            ← Back
          </button>
        )}
      </PageHeader>

      <PageBody>
        {step === 'list' && (
          <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[14px] font-semibold text-ink">Create Custom Shipping Rules</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Rules apply a fixed fulfillment rate per order for a shop, from the date you choose.
              History before that date keeps the rate that applied then.
            </p>

            <div className="mt-4 divide-y divide-line rounded-[var(--radius-control)] border border-line">
              {rates.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12px] text-faint">
                  No rules yet. Orders carry no fulfillment cost until you create one.
                </p>
              ) : (
                rates.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">
                        Default rate - {r.effectiveFrom.slice(0, 10)}
                      </span>
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                        By Default rate
                      </span>
                    </div>
                    <span className="num text-[12px] text-muted">
                      {shops.find((s) => s.id === r.shopId)?.name ?? r.shopId} ·{' '}
                      {formatMoney(r.perOrder, currencyOf(r.shopId))} per order
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setStep('method')}
                className="rounded-[var(--radius-control)] bg-gain px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
              >
                + Create New Rule
              </button>
            </div>
          </section>
        )}

        {step === 'method' && (
          <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[14px] font-semibold text-ink">Create Dynamic Fulfillment Rates</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Report shipping and handling costs based on countries, weight, quantity and more.
            </p>

            <p className="mt-4 text-[12px] font-semibold text-ink">Calculate my shipping costs by:</p>
            <div className="mt-2 space-y-1">
              {LATER_METHODS.map((m) => (
                <div key={m.name} className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 opacity-50">
                  <span className="h-4 w-4 shrink-0 rounded-full border border-line" aria-hidden="true" />
                  <div>
                    <p className="text-[13px] font-medium text-ink">{m.name}</p>
                    <p className="text-[11px] text-muted">{m.blurb}</p>
                  </div>
                  <span className="ml-auto rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-faint">
                    Later phase
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between rounded-[var(--radius-control)] border border-line bg-panel px-4 py-3">
              <div>
                <p className="text-[13px] font-semibold text-ink">Default Rate</p>
                <p className="text-[11px] text-muted">
                  Set a fixed shipping rate to calculate fulfillment cost per order
                </p>
              </div>
              <button
                onClick={() => setStep('rates')}
                className="rounded-[var(--radius-control)] border border-line bg-surface px-4 py-1.5 text-xs font-semibold text-ink hover:bg-panel"
              >
                Edit
              </button>
            </div>

            <div className="mt-4 flex justify-end">
              <button disabled className="rounded-[var(--radius-control)] bg-panel px-4 py-2 text-xs font-semibold text-faint">
                Next
              </button>
            </div>
          </section>
        )}

        {step === 'rates' && (
          <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[14px] font-semibold text-ink">Rates</h2>

            <div className="mt-2 flex gap-4 opacity-50">
              {['% of order price', 'Handling', 'Duties'].map((t) => (
                <span key={t} className="flex items-center gap-1.5 text-[12px] text-muted">
                  <span className="inline-block h-4 w-7 rounded-full bg-panel" aria-hidden="true" />
                  {t}
                </span>
              ))}
            </div>

            <div className="mt-4 rounded-[var(--radius-control)] border border-line">
              <div className="border-b border-line bg-panel px-4 py-2 text-[12px] font-semibold text-ink">
                Default Rate
              </div>
              <div className="grid items-end gap-3 px-4 py-4 sm:grid-cols-2">
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
                    🌐 Worldwide ({currencyOf(shopId)})
                  </label>
                  <input
                    id="rate-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="300"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={`mt-1 w-full ${INPUT}`}
                  />
                </div>
                <div>
                  <label htmlFor="rate-from" className="block text-[11px] font-medium text-muted">From date</label>
                  <input id="rate-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={`mt-1 w-full ${INPUT}`} />
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setStep('method')}
                className="rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-xs font-semibold text-ink hover:bg-panel"
              >
                Back
              </button>
              <button
                onClick={addRate}
                disabled={busy}
                className="whitespace-nowrap rounded-[var(--radius-control)] bg-gain px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </section>
        )}
      </PageBody>
    </AppShell>
  )
}
