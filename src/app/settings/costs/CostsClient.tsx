'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney, toMajor } from '@/lib/money'
import type { Shop } from '@/components/filters/ShopFilter'
import { useToast } from '@/components/toast/useToast'

type Product = {
  id: string
  sku: string
  name: string
  imageUrl: string | null
  sellingPrice: number
  costPerItem: number
  handlingCost: number
  missingCost: boolean
}

/** The product photo, or a neutral placeholder when the shop has not sent one. */
function ProductImage({ product }: { product: Product }) {
  if (!product.imageUrl) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line bg-panel text-decor">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </div>
    )
  }
  // eslint-disable-next-line @next/next/no-img-element -- photos come from arbitrary shop domains
  return (
    <img
      src={product.imageUrl}
      alt=""
      className="h-10 w-10 shrink-0 rounded-[var(--radius-control)] border border-line object-cover"
    />
  )
}

type ShippingRate = {
  id: string
  sku: string
  perUnit: number
  currency: string
  effectiveFrom: string
}

/**
 * The combined view: one row per product, taken from the stock-source shops.
 *
 * A sentinel rather than a shop id, because it is not a shop — it is every source
 * shop's catalogue with the duplicates folded together, which is what the client
 * asked to see. Cannot collide with a cuid.
 */
const SOURCE = 'source'

export function CostsClient({
  email,
  shops,
  /**
   * The currency the stock-source shops share, or null when none is ticked or
   * they disagree.
   *
   * Null keeps this page exactly as it was: one webshop at a time. Costs are
   * stored in minor units of a shop's own currency, so a combined view can only
   * label its inputs honestly when there is one currency to label them with.
   */
  sourceCurrency = null,
}: {
  email: string
  shops: Shop[]
  sourceCurrency?: string | null
}) {
  const [shopId, setShopId] = useState(sourceCurrency ? SOURCE : (shops[0]?.id ?? ''))
  const [currency, setCurrency] = useState('NOK')
  const [products, setProducts] = useState<Product[]>([])
  const [onlyElsewhere, setOnlyElsewhere] = useState(0)
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)

  function load() {
    if (!shopId) {
      // No shop to load for. Say so rather than spinning forever — products
      // belong to a shop, so there is genuinely nothing to fetch.
      setLoading(false)
      return
    }
    setLoading(true)
    fetch(shopId === SOURCE ? '/api/products?source=1' : `/api/products?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setProducts(d.products ?? [])
        setCurrency(d.currency ?? 'NOK')
        setOnlyElsewhere(d.onlyElsewhere ?? 0)
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])

  const shown = onlyMissing ? products.filter((p) => p.missingCost) : products
  const missing = products.filter((p) => p.missingCost).length
  // Products arrive from a shop's orders. With no shop connected there is
  // nothing to cost, so say that rather than blaming an empty catalogue.
  const noShops = shops.length === 0

  return (
    <AppShell email={email}>
      <PageHeader
        title="Product costs"
        // The last sentence is the client's own request, answered where it
        // matters: he was typing the same cost once per webshop, because a cost
        // is stored against a per-shop product row. It now spreads to that SKU
        // everywhere, converted into each shop's currency — and a reader has to
        // know that BEFORE typing, or entering a cost on one shop's row looks
        // like a partial job.
        subtitle="Every product ever sold appears here, with its store price incl. VAT. Enter a cost and it is used for profit from the date you choose, for this product in every webshop that sells it."
      >
        <select
          value={shopId}
          aria-label="Shop"
          onChange={(e) => setShopId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
          {/* First and default, because it is the answer: one row per product
              rather than the same product once per country. The individual shops
              stay below it — they are the only way to reach a product the source
              shops do not sell, and six of those sold last quarter. */}
          {sourceCurrency && (
            <option value={SOURCE}>All stock-source shops ({sourceCurrency})</option>
          )}
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.currency})
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={onlyMissing}
            onChange={(e) => setOnlyMissing(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Only missing costs
        </label>
      </PageHeader>

      <PageBody>
        {/* Never a short list passing as a complete one. These are products the
            source shops do not sell — Swedish and Danish listings — and they
            still need costs, so the sentence says where they are rather than
            leaving them to be discovered. */}
        {shopId === SOURCE && onlyElsewhere > 0 && (
          <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
            <strong className="font-semibold text-ink">
              {onlyElsewhere} product{onlyElsewhere === 1 ? ' is' : 's are'} sold only in your other
              webshops
            </strong>{' '}
            and {onlyElsewhere === 1 ? 'is' : 'are'} not in this list. Pick that webshop above to
            enter a cost for {onlyElsewhere === 1 ? 'it' : 'them'}.
          </div>
        )}

        {missing > 0 && (
          <div className="mb-4 rounded-[var(--radius-card)] border border-line bg-warn-soft px-4 py-3 text-[13px] text-warn">
            <strong className="font-semibold">
              {missing} product{missing > 1 ? 's' : ''} without a cost.
            </strong>{' '}
            Their profit is overstated until you enter one. We never guess a cost.
          </div>
        )}

        <section className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-panel text-[11px] font-semibold text-faint">
                <th className="px-5 py-2 text-left">Product</th>
                <th className="px-4 py-2 text-right">Selling price</th>
                <th className="px-4 py-2 text-right">Cost per item</th>
                <th className="px-4 py-2 text-right">Handling</th>
                <th className="px-5 py-2" />
              </tr>
            </thead>

            <tbody>
              {loading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="border-b border-line last:border-b-0">
                    <td colSpan={5} className="px-5 py-3">
                      <div className="skeleton h-9 w-full" />
                    </td>
                  </tr>
                ))
              ) : noShops ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-[13px] text-muted">
                    <span className="font-semibold text-ink">No shops connected yet.</span>{' '}
                    Product costs belong to a shop —{' '}
                    <Link href="/settings/shops" className="text-accent hover:underline">
                      connect one first
                    </Link>
                    .
                  </td>
                </tr>
              ) : shown.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-[13px] text-muted">
                    No products yet. They appear here automatically once a customer buys one.
                  </td>
                </tr>
              ) : (
                shown.map((p) => (
                  <tr
                    key={p.id}
                    className={`border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-panel ${
                      p.missingCost ? 'bg-warn-soft' : ''
                    }`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <ProductImage product={p} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink">{p.name}</div>
                          <div className="num text-[11px] text-faint">SKU {p.sku}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num px-4 py-3 text-right text-ink">
                      {formatMoney(p.sellingPrice, currency)}
                    </td>
                    <td
                      className={`num px-4 py-3 text-right ${
                        p.missingCost ? 'font-semibold text-warn' : 'text-ink'
                      }`}
                    >
                      {formatMoney(p.costPerItem, currency)}
                    </td>
                    <td className="num px-4 py-3 text-right text-ink">
                      {formatMoney(p.handlingCost, currency)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => setEditing(p)}
                        className="rounded-[var(--radius-control)] border border-line px-2.5 py-1 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-panel"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <ShippingRates shops={shops} sourceCurrency={sourceCurrency} />
      </PageBody>

      {editing && (
        <CostModal
          product={editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </AppShell>
  )
}

const SHIP_INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/**
 * What one unit of a SKU costs us to ship — the client's own request: "add an
 * average unit cost we pay per shipping depending on the supplier ... so it
 * calculate the shipping cost we had to pay based on the SKU and quantity the
 * customer bought".
 *
 * It lives on this page rather than beside the flat per-order rate in Settings ->
 * Fulfillment because it is a per-product cost, typed against a SKU, by whoever
 * is already costing products. It follows the same conventions as that flat rate
 * all the same: list, add, remove, against /api/shipping-rates, which is
 * /api/fulfillment verb for verb.
 */
function ShippingRates({
  shops,
  sourceCurrency,
}: {
  shops: Shop[]
  sourceCurrency: string | null
}) {
  const toast = useToast()
  const [rates, setRates] = useState<ShippingRate[]>([])
  const [sku, setSku] = useState('')
  const [perUnit, setPerUnit] = useState('')
  const [currency, setCurrency] = useState(sourceCurrency ?? shops[0]?.currency ?? 'NOK')
  const [from, setFrom] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    fetch('/api/shipping-rates')
      .then(async (r) => {
        const loaded = r.ok ? ((await r.json()) as { rates: ShippingRate[] }).rates : null
        if (alive && loaded) setRates(loaded)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [reload])

  // Exactly the currencies the shops trade in, because a rate is only in force
  // for an order whose costs are held in the SAME currency — see
  // lib/inventory/shipping.ts. Offering a currency no shop uses would let
  // someone type a rate that could never apply to anything.
  const shopCurrencies = [...new Set(shops.map((s) => s.currency))]
  const currencyOptions = shopCurrencies.length > 0 ? shopCurrencies : [currency]

  async function add() {
    if (!sku.trim() || !perUnit || !from) {
      toast.error('Enter a SKU, a cost per unit and a from date')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/shipping-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, perUnit: Number(perUnit), currency, effectiveFrom: from }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the rate')
        return
      }
      toast.success('Shipping rate saved')
      setSku('')
      setPerUnit('')
      setReload((n) => n + 1)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false) // always — the button must never stick on "Saving…"
    }
  }

  async function remove(rate: ShippingRate) {
    if (
      !window.confirm(
        `Delete the shipping rate for ${rate.sku} from ${rate.effectiveFrom.slice(0, 10)}? Its orders go back to the rate that applied before it, or to your per-order rate.`,
      )
    )
      return
    setBusy(true)
    try {
      const res = await fetch(`/api/shipping-rates?id=${rate.id}`, { method: 'DELETE' })
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

  return (
    <section className="mt-6 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-[14px] font-semibold text-ink">Shipping cost per unit</h2>
        {/* The empty state has to say what happens INSTEAD, or a blank list
            reads as "shipping is free". It is not: every order still carries the
            flat per-order rate from Settings -> Fulfillment until its SKU has a
            rate here, which is what makes this safe to fill in one SKU at a
            time. The currency sentence is the other half a reader needs before
            typing: a rate applies to the webshops trading in its currency, and
            reading a EUR figure as NOK would be an elevenfold error. */}
        <p className="mt-0.5 text-[12px] text-muted">
          What one unit of a product costs us to ship, so an order of fifty costs more to ship
          than an order of one. An order with no rate for its SKU keeps your flat per-order
          fulfillment rate. A rate applies to the webshops that trade in its currency, from the
          date you choose — history before that date keeps the rate that applied then.
        </p>
      </div>

      <div className="divide-y divide-line">
        {rates.length === 0 ? (
          <p className="px-5 py-6 text-center text-[12px] text-faint">
            No per-unit rates yet. Every order is charged your per-order fulfillment rate.
          </p>
        ) : (
          rates.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
              <span className="num font-medium text-ink">{r.sku}</span>
              <span className="num ml-auto text-muted">
                {formatMoney(r.perUnit, r.currency)} per unit
              </span>
              <span className="num text-faint">from {r.effectiveFrom.slice(0, 10)}</span>
              <button
                onClick={() => void remove(r)}
                disabled={busy}
                aria-label={`Delete the shipping rate for ${r.sku} from ${r.effectiveFrom.slice(0, 10)}`}
                className="px-1.5 text-[16px] font-semibold text-muted hover:text-loss disabled:opacity-50"
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>

      <div className="grid items-end gap-3 border-t border-line px-5 py-4 sm:grid-cols-4">
        <div>
          <label htmlFor="ship-sku" className="block text-[11px] font-medium text-muted">
            Shipping SKU
          </label>
          <input
            id="ship-sku"
            value={sku}
            placeholder="PANPIZPRO"
            onChange={(e) => setSku(e.target.value)}
            className={`mt-1 w-full ${SHIP_INPUT}`}
          />
        </div>
        <div>
          <label htmlFor="ship-cost" className="block text-[11px] font-medium text-muted">
            Cost per unit ({currency})
          </label>
          <input
            id="ship-cost"
            type="number"
            min="0"
            step="0.01"
            placeholder="120"
            value={perUnit}
            onChange={(e) => setPerUnit(e.target.value)}
            className={`mt-1 w-full ${SHIP_INPUT}`}
          />
        </div>
        <div>
          <label htmlFor="ship-currency" className="block text-[11px] font-medium text-muted">
            Currency
          </label>
          <select
            id="ship-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={`mt-1 w-full ${SHIP_INPUT}`}
          >
            {currencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ship-from" className="block text-[11px] font-medium text-muted">
            Shipping from date
          </label>
          <input
            id="ship-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={`mt-1 w-full ${SHIP_INPUT}`}
          />
        </div>
      </div>

      <div className="flex justify-end border-t border-line px-5 py-3">
        <button
          onClick={() => void add()}
          disabled={busy}
          className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Add shipping rate'}
        </button>
      </div>
    </section>
  )
}

type ApplyChoice = { apply: 'FUTURE' | 'LAST_60_DAYS' | 'DATE_RANGE'; from?: string }

const TODAY = () => new Date().toISOString().slice(0, 10)

/**
 * "Which orders should this cost apply to?" — asked once for COGS (step 1 of 2), then
 * again for the handling cost (step 2 of 2), exactly as in BeProfit.
 */
function ApplyStep({
  title,
  step,
  choice,
  onChange,
}: {
  title: string
  step: string
  choice: ApplyChoice
  onChange: (c: ApplyChoice) => void
}) {
  const Option = ({ value, children }: { value: ApplyChoice['apply']; children: React.ReactNode }) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] px-1 py-2.5 text-sm text-ink hover:bg-panel">
      <input
        type="radio"
        name={`apply-${step}`}
        checked={choice.apply === value}
        onChange={() => onChange({ apply: value, from: choice.from })}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span>{children}</span>
    </label>
  )

  return (
    <>
      <h2 className="border-b border-line pb-3 text-base font-bold text-ink">
        {title} ({step})
      </h2>

      <div className="mt-3">
        <Option value="FUTURE">
          Apply changes to <strong>future orders</strong> only
        </Option>
        <Option value="LAST_60_DAYS">
          Apply changes to all <strong>matching orders</strong> placed within the{' '}
          <strong>last 60 days</strong>
        </Option>
        <Option value="DATE_RANGE">
          Apply changes to all <strong>matching orders</strong> from a{' '}
          <strong>date you choose</strong> (also applies to future orders)
        </Option>

        {choice.apply === 'DATE_RANGE' && (
          <div className="ml-7 mt-1">
            <input
              type="date"
              aria-label={`${title} apply from`}
              value={choice.from ?? TODAY()}
              onChange={(e) => onChange({ apply: 'DATE_RANGE', from: e.target.value })}
              className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-1.5 text-sm text-ink"
            />
          </div>
        )}
      </div>
    </>
  )
}

function CostModal({
  product,
  currency,
  onClose,
  onSaved,
}: {
  product: Product
  currency: string
  onClose: () => void
  onSaved: () => void
}) {
  // 'costs' = type the numbers, then 'cogs' (1/2) and 'handling' (2/2) ask when each applies.
  const [stage, setStage] = useState<'costs' | 'cogs' | 'handling'>('costs')
  const [cost, setCost] = useState(String(toMajor(product.costPerItem)))
  const [handling, setHandling] = useState(String(toMajor(product.handlingCost)))
  const [costApply, setCostApply] = useState<ApplyChoice>({ apply: 'FUTURE' })
  const [handlingApply, setHandlingApply] = useState<ApplyChoice>({ apply: 'FUTURE' })
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/products/${product.id}/cost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          costPerItem: parseFloat(cost) || 0,
          costApply,
          handlingCost: parseFloat(handling) || 0,
          handlingApply,
        }),
      })
      if (!res.ok) {
        // Keep the modal open: their numbers are still in it, and closing would
        // silently discard the edit while showing the old value.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the cost')
        return
      }

      /**
       * How far the cost reached, said out loud.
       *
       * One cost is now written to this SKU in every webshop that sells it,
       * which is what the client asked for and also completely invisible: the
       * modal closes on the one row he was standing on. A saved-and-that-is-all
       * message would leave him switching shops to check, which is the work this
       * change removed.
       *
       * A skipped shop is named rather than folded into the count. Its profit is
       * still being figured from the old cost, and this is the only place that
       * ever says so.
       */
      const out = (await res.json().catch(() => null)) as
        | { shops?: number; skipped?: { shopName: string; currency: string }[] }
        | null
      const shops = out?.shops ?? 1
      const skipped = out?.skipped ?? []
      const reached = `Cost saved for ${shops} webshop${shops === 1 ? '' : 's'}`

      if (skipped.length > 0) {
        toast.error(
          `${reached}. No exchange rate for ${skipped
            .map((s) => `${s.shopName} (${s.currency})`)
            .join(', ')}, so ${skipped.length === 1 ? 'it is' : 'they are'} still on the old cost.`,
        )
      } else {
        toast.success(reached)
      }
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false) // always — the button must never stick on "Saving…"
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {stage === 'costs' && (
          <>
            <h2 className="text-base font-bold text-ink">Update cost</h2>
            <p className="mt-0.5 text-xs text-muted">{product.name}</p>

            <label htmlFor="cogs" className="mt-4 block text-xs font-medium text-ink">
              Cost per item ({currency})
            </label>
            <input
              id="cogs" type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />

            <label htmlFor="handling" className="mt-3 block text-xs font-medium text-ink">
              Handling cost ({currency})
            </label>
            <input
              id="handling" type="number" step="0.01" value={handling} onChange={(e) => setHandling(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-2 text-xs text-ink hover:text-ink">Cancel</button>
              <button
                onClick={() => setStage('cogs')}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                Next
              </button>
            </div>
          </>
        )}

        {stage === 'cogs' && (
          <>
            <ApplyStep title="Update COGS" step="1/2" choice={costApply} onChange={setCostApply} />
            <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
              <button onClick={onClose} className="px-3 py-2 text-xs text-ink hover:text-ink">Cancel</button>
              <button
                onClick={() => setStage('handling')}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
              >
                Save &amp; Next
              </button>
            </div>
          </>
        )}

        {stage === 'handling' && (
          <>
            <ApplyStep title="Update Handling Cost" step="2/2" choice={handlingApply} onChange={setHandlingApply} />
            <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
              <button onClick={() => setStage('cogs')} className="px-3 py-2 text-xs text-ink hover:text-ink">Back</button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
