'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export type Item = {
  id: string
  sku: string
  name: string
  supplierId: string | null
  productionDays: number | null
  deliveryDays: number | null
  moq: number | null
  unitsPerContainer: number | null
  coverDays: number | null
}

export type Supplier = { id: string; name: string }

const FIELDS = [
  { key: 'productionDays', label: 'Production days' },
  { key: 'deliveryDays', label: 'Delivery days' },
  { key: 'moq', label: 'MOQ' },
  { key: 'unitsPerContainer', label: 'Units per 40HQ' },
  { key: 'coverDays', label: 'Cover days' },
] as const

/**
 * The purchasing facts, one row per product.
 *
 * Every product we sell is listed whether or not anyone has filled it in, and a
 * row that is not ready says so. A page that looked complete while half its
 * rows were empty would produce a forecast full of dashes and no explanation.
 */
export function SuppliersClient({ items, suppliers }: { items: Item[]; suppliers: Supplier[] }) {
  const router = useRouter()
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<Record<string, string>>({})

  const [name, setName] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  async function addSupplier() {
    const trimmed = name.trim()
    if (!trimmed) {
      setAddError('A supplier needs a name.')
      return
    }
    setAddError('')
    setAddBusy(true)
    try {
      const res = await fetch('/api/inventory/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        setAddError('Could not add that supplier.')
        return
      }
      setName('')
      // The supplier dropdown above is server-rendered, so without this a
      // freshly added supplier would not be assignable until a manual reload.
      router.refresh()
    } catch {
      setAddError('Could not reach the server.')
    } finally {
      setAddBusy(false)
    }
  }

  const value = (item: Item, key: string) =>
    draft[item.sku]?.[key] ?? (item[key as keyof Item] === null ? '' : String(item[key as keyof Item]))

  async function save(item: Item) {
    const edits = draft[item.sku] ?? {}
    const body: Record<string, unknown> = { sku: item.sku }

    for (const f of FIELDS) {
      if (!(f.key in edits)) continue
      const raw = edits[f.key].trim()
      if (raw === '') {
        body[f.key] = null // deliberately clearing it
        continue
      }
      const value = Number(raw)
      // Number('1 000') and Number('1,5') are NaN, and JSON.stringify turns NaN
      // into null — which this API reads as "clear this field". Without this
      // guard, typing a thousand the way a Norwegian writes it would silently
      // delete a saved lead time down the same path as an intentional clear.
      if (!Number.isInteger(value) || value < 0) {
        setError((e) => ({ ...e, [item.sku]: `${f.label} must be a whole number, digits only.` }))
        return
      }
      body[f.key] = value
    }
    if ('supplierId' in edits) body.supplierId = edits.supplierId || null

    setError((e) => ({ ...e, [item.sku]: '' }))
    setSaving(item.sku)
    try {
      const res = await fetch('/api/inventory/items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError((e) => ({ ...e, [item.sku]: 'Could not save. Nothing was changed.' }))
        return
      }
      // The row's "needs lead times" warning is server-rendered, so without this
      // a successful save leaves the page still saying the work is undone.
      router.refresh()
    } catch {
      setError((e) => ({ ...e, [item.sku]: 'Could not reach the server. Nothing was changed.' }))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <p className="text-[13px] font-semibold text-ink">Suppliers</p>
        <p className="mt-1 text-[12px] text-muted">
          A supplier has to exist here before any product below can be assigned to one.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[12px] text-muted">
            <span className="block pb-1">Name</span>
            <input
              aria-label="Supplier name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
            />
          </label>

          <button
            onClick={addSupplier}
            disabled={addBusy}
            className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {addBusy ? 'Adding…' : 'Add supplier'}
          </button>
        </div>

        {addError && <p className="mt-2 text-[12px] text-loss">{addError}</p>}

        {suppliers.length > 0 && (
          <p className="mt-3 text-[12px] text-muted">
            Current suppliers: {suppliers.map((s) => s.name).join(', ')}
          </p>
        )}
      </div>

      {items.map((item) => {
        const ready = item.productionDays !== null && item.deliveryDays !== null
        return (
          <div key={item.sku} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[13px] font-semibold text-ink">
                {item.name} <span className="ml-1 font-normal text-faint">{item.sku}</span>
              </p>
              {!ready && (
                <span className="text-[11px] text-warn">
                  needs lead times before it can be forecast
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-[12px] text-muted">
                <span className="block pb-1">Supplier</span>
                <select
                  value={value(item, 'supplierId')}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [item.sku]: { ...d[item.sku], supplierId: e.target.value } }))
                  }
                  className="rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
                >
                  <option value="">—</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>

              {FIELDS.map((f) => (
                <label key={f.key} className="text-[12px] text-muted">
                  <span className="block pb-1">{f.label}</span>
                  <input
                    aria-label={f.label}
                    inputMode="numeric"
                    value={value(item, f.key)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [item.sku]: { ...d[item.sku], [f.key]: e.target.value } }))
                    }
                    className="w-24 rounded-[var(--radius-control)] border border-line bg-canvas px-2 py-1 text-[13px] text-ink"
                  />
                </label>
              ))}

              <button
                onClick={() => save(item)}
                disabled={saving === item.sku}
                className="rounded-[var(--radius-control)] bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                {saving === item.sku ? 'Saving…' : 'Save'}
              </button>
            </div>

            {error[item.sku] && (
              <p className="mt-2 text-[12px] text-loss">{error[item.sku]}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
