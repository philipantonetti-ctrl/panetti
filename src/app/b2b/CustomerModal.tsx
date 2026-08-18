'use client'

import { useEffect, useState } from 'react'
import { SearchableSelect, type SelectOption } from '@/components/SearchableSelect'
import { allCurrencies, isConvertible } from '@/lib/currencies'
import { toMajor } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import type { Shop } from '@/components/filters/ShopFilter'
import type { Customer } from './B2bClient'

/** Every currency, once — the list never changes. */
const CURRENCY_OPTIONS: SelectOption[] = allCurrencies().map((c) => ({ value: c.code, label: c.label }))

type Product = { id: string; sku: string; name: string }
/** A row in the price list being edited. `price` is major units, as typed. */
type PriceRow = { productId: string; price: string }

export function CustomerModal({
  shops,
  customer,
  onClose,
  onSaved,
}: {
  shops: Shop[]
  customer: Customer | null // null = creating a new one
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const editing = customer !== null

  const [shopId, setShopId] = useState(customer?.shopId ?? shops[0]?.id ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [currency, setCurrency] = useState(
    customer?.currency ?? shops.find((s) => s.id === shopId)?.currency ?? 'EUR',
  )
  const [vatPercent, setVatPercent] = useState(String(customer?.vatPercent ?? 0))
  const [email, setEmail] = useState(customer?.email ?? '')
  const [note, setNote] = useState(customer?.note ?? '')
  const [vismaCustomerNumber, setVismaCustomerNumber] = useState(customer?.vismaCustomerNumber ?? '')
  const [rows, setRows] = useState<PriceRow[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [canChangeShop, setCanChangeShop] = useState(true)
  // Creating: nothing to load, so Save stays enabled as it always has. Editing:
  // PATCH replaces the price list wholesale, so Save must stay disabled until
  // their existing prices have actually arrived — otherwise a slow or failed
  // detail fetch lets Save fire with rows still [], wiping every agreed price.
  const [pricesLoaded, setPricesLoaded] = useState(!editing)
  const [busy, setBusy] = useState(false)

  // The catalogue follows the chosen shop; a price must point at a product the
  // shop actually has, and the route refuses anything else.
  useEffect(() => {
    if (!shopId) return
    fetch(`/api/products?shopId=${shopId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProducts(d?.products ?? []))
      .catch(() => setProducts([]))
  }, [shopId])

  // Editing: load their agreed prices and whether the shop is still movable.
  useEffect(() => {
    if (!customer) return
    fetch(`/api/b2b/customers/${customer.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.customer) return
        setCanChangeShop(d.customer.canChangeShop)
        setRows(
          d.customer.prices.map((p: { productId: string; unitPrice: number }) => ({
            productId: p.productId,
            price: String(toMajor(p.unitPrice)),
          })),
        )
        setPricesLoaded(true)
      })
      .catch(() => toast.error('Could not load their agreed prices'))
  }, [customer, toast])

  const productOptions: SelectOption[] = products.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.sku})`,
  }))

  async function save() {
    setBusy(true)
    try {
      const body = {
        ...(canChangeShop ? { shopId } : {}),
        name,
        currency,
        vatPercent: parseFloat(vatPercent) || 0,
        email: email.trim() || null,
        note: note.trim() || null,
        // Sent even when blank, deliberately. Omitting it on an edit would
        // leave an old link standing, and clearing the field is exactly how
        // someone stops a customer's invoices being imported.
        vismaCustomerNumber,
        ...(editing ? { active: customer!.active } : {}),
        prices: rows
          .filter((r) => r.productId && r.price !== '')
          .map((r) => ({ productId: r.productId, unitPrice: parseFloat(r.price) || 0 })),
      }

      const res = await fetch(
        editing ? `/api/b2b/customers/${customer!.id}` : '/api/b2b/customers',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      if (!res.ok) {
        // Keep the form open: what they typed is still in it, and closing
        // would discard the entry while the list shows nothing added.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the customer')
        return
      }
      toast.success(editing ? 'Customer saved' : `${name} added`)
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const shop = shops.find((s) => s.id === shopId)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">
          {editing ? 'Edit business customer' : 'Add business customer'}
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label htmlFor="b2b-name" className="block text-xs font-medium text-ink">Customer name</label>
            <input
              id="b2b-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="E.g. Nordic Retail AS"
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </div>

          <div>
            <label htmlFor="b2b-shop" className="block text-xs font-medium text-ink">Shop</label>
            <select
              id="b2b-shop" value={shopId} disabled={!canChangeShop}
              onChange={(e) => setShopId(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:bg-panel disabled:text-muted"
            >
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>
              ))}
            </select>
            {!canChangeShop && (
              <p className="mt-1 text-[11px] text-muted">
                They already have orders, so their shop is fixed.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="b2b-vat" className="block text-xs font-medium text-ink">VAT rate</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="b2b-vat" type="number" step="0.1" min="0" max="100"
                value={vatPercent} onChange={(e) => setVatPercent(e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
              />
              <span className="text-sm text-muted">%</span>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              25 for a domestic business, 0 for reverse charge or export.
            </p>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-ink">Currency they pay in</label>
            <div className="mt-1 w-52">
              <SearchableSelect
                ariaLabel="Currency" value={currency} onChange={setCurrency} options={CURRENCY_OPTIONS}
              />
            </div>
            {/* Be honest: we only hold exchange rates for the ECB's list. */}
            {!isConvertible(currency) && (
              <p className="mt-1.5 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[11px] leading-relaxed text-warn">
                ⚠️ We have no exchange rate for <strong>{currency}</strong>, so their orders cannot be
                folded into the multi-shop USD totals. Their own figures stay exact.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="b2b-email" className="block text-xs font-medium text-ink">Email (optional)</label>
            <input
              id="b2b-email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div>
            <label htmlFor="b2b-note" className="block text-xs font-medium text-ink">Note (optional)</label>
            <input
              id="b2b-note" value={note} onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>

          <div className="col-span-2">
            <label htmlFor="b2b-visma" className="block text-xs font-medium text-ink">
              Visma customer number (optional)
            </label>
            <input
              id="b2b-visma" value={vismaCustomerNumber}
              onChange={(e) => setVismaCustomerNumber(e.target.value)}
              placeholder="E.g. 10705"
              className="mt-1 w-52 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
            <p className="mt-1 text-[11px] text-muted">
              Invoices raised for this customer in Visma become their orders here automatically.
              Leave it empty and nothing is imported for them.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs font-medium text-ink">Agreed prices</p>
          <p className="text-[11px] text-muted">
            Per unit, excluding VAT, in {currency}. These fill themselves in when you enter an order.
          </p>

          {products.length === 0 && (
            <p className="mt-2 rounded-[var(--radius-control)] bg-panel px-3 py-2 text-[11px] text-muted">
              This shop has no products yet. A product appears once it has sold through the webshop.
            </p>
          )}

          <div className="mt-2 space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SearchableSelect
                    ariaLabel={`Product ${i + 1}`}
                    value={row.productId}
                    onChange={(v) =>
                      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, productId: v } : r)))
                    }
                    options={productOptions}
                  />
                </div>
                <input
                  type="number" step="0.01" min="0" value={row.price}
                  aria-label={`Price ${i + 1}`}
                  onChange={(e) =>
                    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))
                  }
                  className="w-32 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
                <button
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove price ${i + 1}`}
                  className="rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={() => setRows((prev) => [...prev, { productId: '', price: '' }])}
            disabled={products.length === 0}
            className="mt-2 rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-panel disabled:opacity-60"
          >
            + Add a product price
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-ink">Cancel</button>
          <button
            onClick={save}
            disabled={busy || !name.trim() || !shopId || !shop || !pricesLoaded}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add customer'}
          </button>
        </div>
      </div>
    </div>
  )
}
