'use client'

import { useEffect, useState } from 'react'
import { TopBar } from '@/components/TopBar'
import { formatMoney, toMajor } from '@/lib/money'
import type { Shop } from '@/components/ShopSelector'

type Product = {
  id: string
  sku: string
  name: string
  sellingPrice: number
  costPerItem: number
  handlingCost: number
  missingCost: boolean
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
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-[11px] text-slate-400">SKU {p.sku}</div>
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
  const [cost, setCost] = useState(String(toMajor(product.costPerItem)))
  const [handling, setHandling] = useState(String(toMajor(product.handlingCost)))
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await fetch(`/api/products/${product.id}/cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        costPerItem: parseFloat(cost) || 0,
        handlingCost: parseFloat(handling) || 0,
        effectiveFrom,
      }),
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-slate-900">Update cost</h2>
        <p className="mt-0.5 text-xs text-slate-500">{product.name}</p>

        <label className="mt-4 block text-xs font-medium text-slate-600">Cost per item ({currency})</label>
        <input
          type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-xs font-medium text-slate-600">Handling cost ({currency})</label>
        <input
          type="number" step="0.01" value={handling} onChange={(e) => setHandling(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <label className="mt-3 block text-xs font-medium text-slate-600">Apply this cost from</label>
        <input
          type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          Orders <strong>before</strong> this date keep the previous cost.<br />
          Orders <strong>from</strong> this date onward use the new one.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
