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
  /**
   * False for something we stock but never reorder — spare parts and the like.
   *
   * Hiding, never deleting. A deleted row is back on the next page load, because
   * ensureSupplyItems recreates one per product SKU, and the Woo sync upserts the
   * product itself on every order it reads. This flag is the only thing that can
   * make the system forget a product, and it also removes it from the forecast,
   * from purchase orders and from the product cost list.
   */
  active: boolean
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
export function SuppliersClient({
  items,
  suppliers,
  /**
   * Products no shop named as a stock source sells.
   *
   * Kept out of the working list because the client's complaint was that one
   * product appeared several times over, once per country's webshop. Kept on the
   * page because a product the source shops do not list is still a product we
   * may buy — PC-AF-BOWL sold this quarter — and its lead times, supplier and
   * open orders are all real.
   *
   * Defaults to empty, which is exactly how this page behaved before any shop
   * was named a source: everything is carried and there is no second drawer.
   */
  elsewhere = [],
}: {
  items: Item[]
  suppliers: Supplier[]
  elsewhere?: Item[]
}) {
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

  const [showHidden, setShowHidden] = useState(false)
  const [showElsewhere, setShowElsewhere] = useState(false)

  const visible = items.filter((i) => i.active)
  const onlyElsewhere = elsewhere.filter((i) => i.active)
  // Both lists, because hiding is a deliberate human act and stays the stronger
  // statement: a product that is hidden AND unstocked by the source shops
  // belongs in one drawer, not two, or the two counts report the same row twice.
  const hidden = [...items, ...elsewhere].filter((i) => !i.active)

  /**
   * Take a product out of the system's sight, or bring it back.
   *
   * Sent as a real boolean because the API refuses anything else rather than
   * coercing it: a product hidden by accident is invisible by definition, so
   * that mistake would never announce itself.
   */
  async function setActive(item: Item, active: boolean) {
    const failed = active
      ? 'Could not bring that back. Nothing was changed.'
      : 'Could not hide that. Nothing was changed.'

    setError((e) => ({ ...e, [item.sku]: '' }))
    setSaving(item.sku)
    try {
      const res = await fetch('/api/inventory/items', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: item.sku, active }),
      })
      if (!res.ok) {
        setError((e) => ({ ...e, [item.sku]: failed }))
        return
      }
      // The lists are server-rendered, so without this the row stays put and the
      // click looks as though it did nothing.
      router.refresh()
    } catch {
      setError((e) => ({ ...e, [item.sku]: failed }))
    } finally {
      setSaving(null)
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

  /**
   * One editable purchasing row.
   *
   * A function rather than duplicated JSX, because the drawer of products only
   * the other webshops sell renders exactly this. Two copies would drift, and
   * the copy that fell behind would be the one nobody looks at — the drawer.
   */
  const row = (item: Item) => {
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

          <button
            onClick={() => setActive(item, false)}
            disabled={saving === item.sku}
            className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-muted disabled:opacity-50"
          >
            Hide
          </button>
        </div>

        {error[item.sku] && (
          <p className="mt-2 text-[12px] text-loss">{error[item.sku]}</p>
        )}
      </div>
    )
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

      {/* The field the client misread: he typed 45 expecting 45 days of sales
          and the forecast, which then still added the lead time on top,
          offered 200 days' worth. Said once, where the number is typed. */}
      <p className="text-[12px] text-muted">
        Cover days is how long one order should last once it lands. The forecast suggests that
        many days of sales, rounded up to the supplier minimum and to whole containers.
      </p>

      {visible.map(row)}

      {/*
        The products the source shops do not sell.

        Collapsed, and absent entirely when there are none — which is the state
        of every workspace until somebody names a source shop. Fully editable
        inside, not merely listed: PC-AF-BOWL sold this quarter without either
        .no shop carrying it, and a product we buy has to be a product we can
        give a supplier and lead times to.
      */}
      {onlyElsewhere.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <button
            onClick={() => setShowElsewhere((v) => !v)}
            className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
          >
            {showElsewhere
              ? `Hide the ${onlyElsewhere.length} sold only in other webshops`
              : `Show ${onlyElsewhere.length} sold only in other webshops`}
          </button>
          <p className="mt-1 text-[12px] text-muted">
            The list above is what your stock-source shops carry, so each product appears once
            rather than once per country. Lead times you set anywhere apply to that SKU in every
            webshop.
          </p>

          {showElsewhere && <div className="mt-3 space-y-3">{onlyElsewhere.map(row)}</div>}
        </div>
      )}

      {/*
        Collapsed by default, and absent entirely when nothing is hidden. The
        list above is the working list; this is the drawer you open on the rare
        day you want something back. Only the name and the SKU are shown —
        nobody fills in lead times for a product they have told us to forget.
      */}
      {hidden.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="text-[13px] font-semibold text-ink underline-offset-2 hover:underline"
          >
            {showHidden ? `Hide again (${hidden.length})` : `Show hidden (${hidden.length})`}
          </button>
          <p className="mt-1 text-[12px] text-muted">
            Hidden products are left out of the forecast, purchase orders and product costs.
            Nothing about them is deleted, and their order history is untouched.
          </p>

          {showHidden && (
            <div className="mt-3 space-y-2">
              {hidden.map((item) => (
                <div
                  key={item.sku}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2"
                >
                  <p className="text-[13px] text-ink">
                    {item.name} <span className="ml-1 text-faint">{item.sku}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    {error[item.sku] && (
                      <span className="text-[12px] text-loss">{error[item.sku]}</span>
                    )}
                    <button
                      onClick={() => setActive(item, true)}
                      disabled={saving === item.sku}
                      className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-[13px] text-muted disabled:opacity-50"
                    >
                      Unhide
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
