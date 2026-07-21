'use client'

import Link from 'next/link'
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
  {
    name: 'Order Weight',
    blurb: 'Shipping rates based on order weight tiers',
    info: 'Set rate tiers by total order weight, for example 0 to 1 kg costs 49 kr and over 5 kg costs 129 kr. Coming in a later phase.',
  },
  {
    name: 'Order Quantity',
    blurb: 'Shipping rates based on order quantity tiers',
    info: 'Set rate tiers by how many items an order holds, for example 1 to 3 items costs 59 kr. Coming in a later phase.',
  },
  {
    name: 'Order Price',
    blurb: 'Shipping rates based on order price tiers',
    info: 'Set rate tiers by order value, for example orders over 1 000 kr ship free. Coming in a later phase.',
  },
  {
    name: 'Shipping Carrier',
    blurb: 'Rates from keywords in your carrier titles',
    info: 'Match rates by carrier name keywords, for example Posten or Bring. Coming in a later phase.',
  },
  {
    name: 'Shipping Title',
    blurb: 'Rates from keywords in your shipping method titles',
    info: 'Match rates by shipping method titles, for example Home delivery. Coming in a later phase.',
  },
  {
    name: 'Other',
    blurb: 'More conditions to calculate your shipping costs by',
    info: 'More conditions such as country or product tags. Coming in a later phase.',
  },
]

/** A real tooltip: shows on hover and on keyboard focus, reads aloud its purpose. */
function Info({ name, text }: { name: string; text: string }) {
  return (
    <span className="group relative inline-block align-middle">
      <button
        type="button"
        aria-label={`About ${name}`}
        onClick={(e) => e.preventDefault()}
        className="px-0.5 text-[12px] text-faint hover:text-ink focus:text-ink"
      >
        ⓘ
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-60 -translate-x-1/2 rounded-[var(--radius-control)] bg-ink px-3 py-2 text-left text-[11px] font-normal leading-snug text-white shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  )
}

/**
 * BeProfit-shaped flow, default-rate engine underneath:
 * rules list -> Create New Rule -> profile methods -> Edit -> rates -> Save.
 */
export function FeesClient({ email, shops }: { email: string; shops: Shop[] }) {
  const toast = useToast()
  const [step, setStep] = useState<Step>('list')
  const [rates, setRates] = useState<Rate[]>([])
  const [busy, setBusy] = useState(false)
  const [method, setMethod] = useState<string | null>(null)

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

  async function removeRate(rate: Rate) {
    if (!window.confirm(`Delete the rate from ${rate.effectiveFrom.slice(0, 10)}? Orders go back to the rate that applied before it.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/fulfillment?id=${rate.id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not delete the rate')
        return
      }
      toast.success('Rate deleted')
      setReload((n) => n + 1)
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
        {step === 'list' ? (
          <Link
            href="/settings/shops"
            className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink hover:bg-panel"
          >
            🛡 Manage Integrations
          </Link>
        ) : (
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
                  <div key={r.id} className="flex items-center gap-2 px-4 py-2.5">
                    <span aria-hidden="true" className="cursor-default text-[13px] tracking-tighter text-faint">⋮⋮</span>
                    <span aria-hidden="true" className="text-faint">›</span>
                    <span className="text-[13px] font-semibold text-ink">
                      Default rate - {r.effectiveFrom.slice(0, 10)}
                    </span>
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                      By Default rate
                    </span>
                    <span className="num ml-auto text-[12px] text-muted">
                      {shops.find((s) => s.id === r.shopId)?.name ?? r.shopId} ·{' '}
                      {formatMoney(r.perOrder, currencyOf(r.shopId))} per order
                    </span>
                    <button
                      onClick={() => void removeRate(r)}
                      disabled={busy}
                      aria-label={`Delete rate from ${r.effectiveFrom.slice(0, 10)}`}
                      title="Delete this rule"
                      className="px-1.5 text-[16px] font-semibold text-muted hover:text-loss disabled:opacity-50"
                    >
                      ⋯
                    </button>
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

        {step === 'list' && (
          <Link
            href="/settings/expenses"
            className="mt-4 block max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5 transition-colors duration-150 hover:bg-panel"
          >
            <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <span aria-hidden="true" className="text-faint">›</span> 💰 Add Custom or Variable Expenses
            </p>
            <p className="mt-0.5 text-[12px] text-muted">
              Enrich your fulfillment cost control with one-time or recurring operational expenses.
            </p>
          </Link>
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
                <label
                  key={m.name}
                  className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 hover:bg-panel"
                >
                  <input
                    type="radio"
                    name="fulfillment-method"
                    checked={method === m.name}
                    onChange={() => setMethod(m.name)}
                    aria-label={m.name}
                    className="h-4 w-4 shrink-0 accent-[var(--color-ink)]"
                  />
                  <div>
                    <p className="text-[13px] font-medium text-ink">
                      {m.name} <Info name={m.name} text={m.info} />
                    </p>
                    <p className="text-[11px] text-muted">{m.blurb}</p>
                  </div>
                </label>
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
              <button
                onClick={() =>
                  toast.error(
                    `${method} rates are coming in a later phase. Use Default Rate (Edit) for now.`,
                  )
                }
                disabled={!method}
                className="rounded-[var(--radius-control)] bg-gain px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:bg-panel disabled:text-faint"
              >
                Next
              </button>
            </div>
          </section>
        )}

        {step === 'rates' && (
          <section className="max-w-3xl rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[14px] font-semibold text-ink">Rates</h2>

            <div className="mt-2 flex gap-4">
              {['% of order price', 'Handling', 'Duties'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    toast.error(
                      `${t} is coming in a later phase. The Worldwide amount below is the full per-order rate for now.`,
                    )
                  }
                  className="flex items-center gap-1.5 text-[12px] text-muted transition-colors duration-150 hover:text-ink"
                >
                  <span className="inline-block h-4 w-7 rounded-full border border-line bg-panel" aria-hidden="true" />
                  {t}
                </button>
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
