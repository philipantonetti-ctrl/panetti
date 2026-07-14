'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney, toMajor } from '@/lib/money'
import type { Shop } from '@/components/filters/ShopFilter'

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

export function CostsClient({ email, shops }: { email: string; shops: Shop[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? '')
  const [currency, setCurrency] = useState('NOK')
  const [products, setProducts] = useState<Product[]>([])
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)

  function load() {
    if (!shopId) return
    setLoading(true)
    fetch(`/api/products?shopId=${shopId}`)
      .then((r) => r.json())
      .then((d) => {
        setProducts(d.products ?? [])
        setCurrency(d.currency ?? 'NOK')
      })
      .finally(() => setLoading(false))
  }

  useEffect(load, [shopId])

  const shown = onlyMissing ? products.filter((p) => p.missingCost) : products
  const missing = products.filter((p) => p.missingCost).length

  return (
    <AppShell email={email}>
      <PageHeader
        title="Product costs"
        subtitle="Every product ever sold appears here. Enter a cost and it is used for profit from the date you choose."
      >
        <select
          value={shopId}
          aria-label="Shop"
          onChange={(e) => setShopId(e.target.value)}
          className="rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink"
        >
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

  async function save() {
    setBusy(true)
    await fetch(`/api/products/${product.id}/cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        costPerItem: parseFloat(cost) || 0,
        costApply,
        handlingCost: parseFloat(handling) || 0,
        handlingApply,
      }),
    })
    setBusy(false)
    onSaved()
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
