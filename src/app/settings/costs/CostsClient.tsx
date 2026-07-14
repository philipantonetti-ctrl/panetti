'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney, toMajor } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'

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
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-300">
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
      className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 object-cover"
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
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-6xl p-5">
        <h1 className="text-lg font-bold text-slate-900">Product costs</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every product ever sold appears here. Fill in the cost and it will be used for profit from the
          date you choose.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.currency})
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} className="accent-violet-700" />
            Only missing costs
          </label>

          {missing > 0 && (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
              ⚠️ {missing} product{missing > 1 ? 's' : ''} without a cost
            </span>
          )}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-right text-slate-500">
                <th className="px-3 py-2.5 text-left font-medium">Product</th>
                <th className="px-3 py-2.5 font-medium">Selling price</th>
                <th className="px-3 py-2.5 font-medium">Cost per item</th>
                <th className="px-3 py-2.5 font-medium">Handling</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-right text-slate-700">
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">Loading…</td></tr>
              ) : shown.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">No products.</td></tr>
              ) : (
                shown.map((p) => (
                  <tr key={p.id} className={`border-t border-slate-100 ${p.missingCost ? 'bg-amber-50/60' : ''}`}>
                    <td className="px-3 py-2.5 text-left">
                      <div className="flex items-center gap-3">
                        <ProductImage product={p} />
                        <div>
                          <div className="font-medium text-slate-900">{p.name}</div>
                          <div className="text-[11px] text-slate-400">SKU {p.sku}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">{formatMoney(p.sellingPrice, currency)}</td>
                    <td className={`px-3 py-2.5 ${p.missingCost ? 'font-semibold text-amber-700' : ''}`}>
                      {formatMoney(p.costPerItem, currency)}
                    </td>
                    <td className="px-3 py-2.5">{formatMoney(p.handlingCost, currency)}</td>
                    <td className="px-3 py-2.5">
                      <button onClick={() => setEditing(p)} className="font-semibold text-violet-700 hover:underline">
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

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
    </div>
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
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-2.5 text-sm text-black hover:bg-slate-50">
      <input
        type="radio"
        name={`apply-${step}`}
        checked={choice.apply === value}
        onChange={() => onChange({ apply: value, from: choice.from })}
        className="mt-0.5 accent-violet-700"
      />
      <span>{children}</span>
    </label>
  )

  return (
    <>
      <h2 className="border-b border-slate-100 pb-3 text-base font-bold text-black">
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
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-black"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {stage === 'costs' && (
          <>
            <h2 className="text-base font-bold text-black">Update cost</h2>
            <p className="mt-0.5 text-xs text-slate-500">{product.name}</p>

            <label htmlFor="cogs" className="mt-4 block text-xs font-medium text-slate-700">
              Cost per item ({currency})
            </label>
            <input
              id="cogs" type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black"
            />

            <label htmlFor="handling" className="mt-3 block text-xs font-medium text-slate-700">
              Handling cost ({currency})
            </label>
            <input
              id="handling" type="number" step="0.01" value={handling} onChange={(e) => setHandling(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-black"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-2 text-xs text-slate-700 hover:text-black">Cancel</button>
              <button
                onClick={() => setStage('cogs')}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Next
              </button>
            </div>
          </>
        )}

        {stage === 'cogs' && (
          <>
            <ApplyStep title="Update COGS" step="1/2" choice={costApply} onChange={setCostApply} />
            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button onClick={onClose} className="px-3 py-2 text-xs text-slate-700 hover:text-black">Cancel</button>
              <button
                onClick={() => setStage('handling')}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Save &amp; Next
              </button>
            </div>
          </>
        )}

        {stage === 'handling' && (
          <>
            <ApplyStep title="Update Handling Cost" step="2/2" choice={handlingApply} onChange={setHandlingApply} />
            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button onClick={() => setStage('cogs')} className="px-3 py-2 text-xs text-slate-700 hover:text-black">Back</button>
              <button
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
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
