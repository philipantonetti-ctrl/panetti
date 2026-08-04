'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatMoney, toMajor, toMinor } from '@/lib/money'
import { lineTotals, orderTotals, type B2bLine, type DiscountKind } from '@/lib/b2b/pricing'
import { useToast } from '@/components/toast/useToast'
import type { Customer } from './B2bClient'

type Product = { id: string; sku: string; name: string }
type AgreedPrice = { productId: string; unitPrice: number }

/** One row of the form. Everything is a string — it is what was typed. */
type Row = {
  productId: string
  quantity: string
  unitPrice: string
  discountValue: string
  discountKind: DiscountKind
  savePrice: boolean
}

const emptyRow = (): Row => ({
  productId: '',
  quantity: '1',
  unitPrice: '',
  discountValue: '',
  discountKind: 'PERCENT',
  savePrice: false,
})

/** One line as `GET /api/b2b/orders/[id]` returns it — minor units on the wire. */
type LoadedLine = {
  productId: string
  quantity: number
  unitPrice: number
  discountValue: number
  discountKind: DiscountKind
}

const today = () => new Date().toISOString().slice(0, 10)

export function OrderModal({
  customers,
  order,
  onClose,
  onSaved,
}: {
  customers: Customer[]
  /** Absent = creating. Present = editing that order. */
  order?: { id: string } | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const editing = order != null

  const [customerId, setCustomerId] = useState('')
  const [placedAt, setPlacedAt] = useState(today())
  const [rows, setRows] = useState<Row[]>([])
  const [shippingCharged, setShippingCharged] = useState('')
  const [fulfillmentCost, setFulfillmentCost] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [agreed, setAgreed] = useState<AgreedPrice[]>([])
  const [shopCurrency, setShopCurrency] = useState('')
  const [busy, setBusy] = useState(false)
  // Editing only: the order's own number, once it has actually loaded — used
  // both for the heading and to gate Save so it cannot fire on a still-empty
  // form while the fetch is in flight (the same defect `pickCustomer`'s
  // comment above describes, one step later).
  const [loaded, setLoaded] = useState<{ number: string } | null>(null)

  const customer = customers.find((c) => c.id === customerId) ?? null

  // Picking the customer decides everything else: which catalogue, which
  // currency, which VAT rate, and which prices fill themselves in.
  useEffect(() => {
    if (!customer) return
    fetch(`/api/b2b/customers/${customer.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setAgreed(d?.customer?.prices ?? [])
        setShopCurrency(d?.customer?.shopCurrency ?? '')
      })
      .catch(() => toast.error('Could not load their agreed prices'))

    fetch(`/api/products?shopId=${customer.shopId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProducts(d?.products ?? []))
      .catch(() => setProducts([]))
  }, [customer, toast])

  /** What the pure module works on. The server derives the same from the same input. */
  const engineLines: B2bLine[] = useMemo(
    () =>
      rows.map((r) => ({
        quantity: parseInt(r.quantity, 10) || 0,
        unitPrice: toMinor(parseFloat(r.unitPrice) || 0),
        discountValue:
          r.discountKind === 'PERCENT'
            ? parseFloat(r.discountValue) || 0
            : toMinor(parseFloat(r.discountValue) || 0),
        discountKind: r.discountKind,
      })),
    [rows],
  )

  const totals = useMemo(
    () =>
      orderTotals(
        engineLines,
        toMinor(parseFloat(shippingCharged) || 0),
        customer?.vatPercent ?? 0,
      ),
    [engineLines, shippingCharged, customer],
  )

  const currency = customer?.currency ?? ''

  /**
   * Switching customers must drop everything the PREVIOUS one's fetch left
   * behind, not just the rows. Otherwise, switching to a customer on a
   * different shop shows the old shop's currency on the shipping-cost field
   * — and leaves it enabled — until the new fetch resolves: the same
   * wrong-currency defect closed for the never-loads case, reached by a
   * second path. Agreed prices reset for the same reason: `agreed = []` is
   * what "no agreed price yet" already looks like on this form, so this
   * borrows an existing, honest empty state rather than ever risking someone
   * else's price. The product catalogue resets too, so a line added
   * mid-switch cannot offer the old shop's SKUs.
   */
  function pickCustomer(id: string) {
    setCustomerId(id)
    setRows([])
    setShopCurrency('')
    setAgreed([])
    setProducts([])
  }

  // Editing: pull the order back in the shape this form speaks. pickCustomer
  // clears the rows by design (see its comment above), so it runs first and
  // the loaded lines land after — never the other way round, or they would
  // be wiped the instant they were set.
  useEffect(() => {
    if (!order) return
    fetch(`/api/b2b/orders/${order.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.order) {
          toast.error('Could not load that order')
          return
        }
        const o = d.order
        pickCustomer(o.customerId)
        setPlacedAt(o.placedAt)
        setShippingCharged(String(toMajor(o.shippingCharged)))
        setFulfillmentCost(String(toMajor(o.fulfillmentCost)))
        setRows(
          o.lines.map((l: LoadedLine) => ({
            productId: l.productId,
            quantity: String(l.quantity),
            unitPrice: String(toMajor(l.unitPrice)),
            // PERCENT is a plain number and must not be divided; AMOUNT is
            // money in minor units and must go through toMajor. Getting this
            // backwards is a silent 100x error on every discounted line.
            discountValue:
              l.discountKind === 'PERCENT' ? String(l.discountValue) : String(toMajor(l.discountValue)),
            discountKind: l.discountKind,
            // These prices are already what was agreed, or already a
            // recorded one-off; re-saving them as the standing price on an
            // edit would be a surprise nobody asked for.
            savePrice: false,
          })),
        )
        setLoaded({ number: o.number })
      })
      .catch(() => toast.error('Could not load that order'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id])

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  /** Picking a product pulls their agreed price in, when there is one. */
  function pickProduct(i: number, productId: string) {
    const price = agreed.find((p) => p.productId === productId)
    setRow(i, {
      productId,
      unitPrice: price ? String(toMajor(price.unitPrice)) : '',
      // Nothing is agreed yet, so offer to remember what gets typed.
      savePrice: !price,
    })
  }

  async function save() {
    if (!customer) return
    setBusy(true)
    try {
      const res = await fetch(
        editing ? `/api/b2b/orders/${order!.id}` : '/api/b2b/orders',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: customer.id,
            placedAt,
            shippingCharged: parseFloat(shippingCharged) || 0,
            fulfillmentCost: parseFloat(fulfillmentCost) || 0,
            lines: rows
              .filter((r) => r.productId)
              .map((r) => ({
                productId: r.productId,
                quantity: parseInt(r.quantity, 10) || 0,
                unitPrice: parseFloat(r.unitPrice) || 0,
                discountValue: parseFloat(r.discountValue) || 0,
                discountKind: r.discountKind,
                savePrice: r.savePrice,
              })),
          }),
        },
      )

      if (!res.ok) {
        // Keep the form open — closing would discard everything typed while
        // the list shows nothing added.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the order')
        return
      }
      // PATCH answers `{ ok: true }`, not the order — an edit is still the
      // same order, so its number is the one already loaded, not something
      // to read back off this response.
      toast.success(
        editing
          ? `Order ${loaded?.number ?? ''} saved`
          : `Order ${(await res.json()).order.number} added`,
      )
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  const usable = rows.filter((r) => r.productId && r.unitPrice !== '')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="border-b border-line pb-3 text-base font-bold text-ink">
          {editing ? `Edit order ${loaded?.number ?? ''}` : 'Add other revenue'}
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="b2b-customer" className="block text-xs font-medium text-ink">Customer</label>
            <select
              id="b2b-customer" aria-label="Customer" value={customerId}
              disabled={editing}
              onChange={(e) => pickCustomer(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:bg-panel disabled:text-muted"
            >
              <option value="">Choose a customer…</option>
              {customers.filter((c) => c.active).map((c) => (
                <option key={c.id} value={c.id}>{c.name} — {c.shopName} ({c.currency})</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="b2b-date" className="block text-xs font-medium text-ink">Order date</label>
            <input
              id="b2b-date" type="date" value={placedAt} onChange={(e) => setPlacedAt(e.target.value)}
              className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </div>
        </div>

        {customer && (
          <p className="mt-2 rounded-[var(--radius-control)] bg-panel px-3 py-2 text-[11px] text-muted">
            {customer.shopName} · invoiced in {customer.currency} · VAT {customer.vatPercent}% · no
            card fee
          </p>
        )}

        {customer && (
          <>
            <div className="mt-4 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-ink">What they bought</p>
                <button
                  onClick={() => setRows((prev) => [...prev, emptyRow()])}
                  className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:bg-panel"
                >
                  + Add a line
                </button>
              </div>

              {products.length === 0 && (
                <p className="mt-2 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  Only products that have sold through this shop can be added. Sync the shop, or check
                  the name.
                </p>
              )}

              <div className="mt-2 space-y-2">
                {rows.map((r, i) => {
                  const t = lineTotals(engineLines[i])
                  const noAgreedPrice = !!r.productId && !agreed.some((p) => p.productId === r.productId)
                  return (
                    <div key={i} className="grid grid-cols-12 items-center gap-2">
                      <select
                        aria-label={`Product ${i + 1}`} value={r.productId}
                        onChange={(e) => pickProduct(i, e.target.value)}
                        className="col-span-4 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      >
                        <option value="">Choose…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
                        ))}
                      </select>

                      <input
                        aria-label={`Quantity ${i + 1}`} type="number" min="1" value={r.quantity}
                        onChange={(e) => setRow(i, { quantity: e.target.value })}
                        className="col-span-1 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      />

                      <input
                        aria-label={`Unit price ${i + 1}`} type="number" step="0.01" min="0"
                        value={r.unitPrice} placeholder="Price"
                        onChange={(e) => setRow(i, { unitPrice: e.target.value })}
                        className={`col-span-2 rounded-[var(--radius-control)] border bg-surface px-2 py-2 text-sm text-ink ${
                          noAgreedPrice && r.unitPrice === '' ? 'border-warn bg-warn-soft' : 'border-line'
                        }`}
                      />

                      <input
                        aria-label={`Discount ${i + 1}`} type="number" step="0.01" min="0"
                        value={r.discountValue} placeholder="0"
                        onChange={(e) => setRow(i, { discountValue: e.target.value })}
                        className="col-span-1 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      />

                      <select
                        aria-label={`Discount kind ${i + 1}`} value={r.discountKind}
                        onChange={(e) => setRow(i, { discountKind: e.target.value as DiscountKind })}
                        className="col-span-2 rounded-[var(--radius-control)] border border-line bg-surface px-2 py-2 text-sm text-ink"
                      >
                        <option value="PERCENT">%</option>
                        {/* Per unit, not per line — the same frame as the price beside it. */}
                        <option value="AMOUNT">{currency} / unit</option>
                      </select>

                      <span
                        data-testid={`line-total-${i + 1}`}
                        className="num col-span-1 text-right text-sm text-ink"
                      >
                        {formatMoney(t.net, currency)}
                      </span>

                      <button
                        onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove line ${i + 1}`}
                        className="col-span-1 rounded px-2 py-1 text-faint hover:bg-panel hover:text-ink"
                      >
                        ×
                      </button>

                      {noAgreedPrice && (
                        <label className="col-span-12 flex items-center gap-2 pl-1 text-[11px] text-muted">
                          <input
                            type="checkbox" aria-label={`Save price ${i + 1}`} checked={r.savePrice}
                            onChange={(e) => setRow(i, { savePrice: e.target.checked })}
                            className="accent-[var(--color-accent)]"
                          />
                          Save this as {customer.name}&apos;s standing price
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
              <div>
                <label htmlFor="b2b-shipping" className="block text-xs font-medium text-ink">
                  Shipping charged ({currency})
                </label>
                <p className="text-[11px] text-muted">What they paid you for delivery, ex VAT.</p>
                <input
                  id="b2b-shipping" type="number" step="0.01" min="0" value={shippingCharged}
                  onChange={(e) => setShippingCharged(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink"
                />
              </div>

              <div>
                <label htmlFor="b2b-fulfil" className="block text-xs font-medium text-ink">
                  {/* Never fall back to the customer's currency here: that is a
                      different currency, and this field is a cost. Until the
                      shop's own currency has actually arrived — including if
                      the fetch never comes back — say so instead of guessing. */}
                  Shipping we paid {shopCurrency ? `(${shopCurrency})` : '(…)'}
                </label>
                <p className="text-[11px] text-muted">
                  A cost, so it is in the shop&apos;s currency like every other cost.
                </p>
                <input
                  id="b2b-fulfil" type="number" step="0.01" min="0" value={fulfillmentCost}
                  disabled={!shopCurrency}
                  onChange={(e) => setFulfillmentCost(e.target.value)}
                  className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:bg-panel disabled:text-muted"
                />
              </div>
            </div>

            <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
              {[
                ['Gross sales', totals.grossSales, 'gross-sales'],
                ['Discount', -totals.discountTotal, 'discount'],
                ['Net sales', totals.netSales, 'net-sales'],
                ['Shipping', totals.shippingCharged, 'shipping'],
                [`VAT (${customer.vatPercent}%)`, totals.taxTotal, 'vat'],
              ].map(([label, value, key]) => (
                <div key={key as string} className="flex justify-between text-muted">
                  <dt>{label as string}</dt>
                  <dd data-testid={`total-${key as string}`} className="num text-ink">
                    {formatMoney(value as number, currency)}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-1 font-semibold text-ink">
                <dt>Total</dt>
                <dd data-testid="total-total" className="num">{formatMoney(totals.total, currency)}</dd>
              </div>
            </dl>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button onClick={onClose} className="px-3 py-2 text-xs text-ink">Cancel</button>
          <button
            onClick={save}
            // Editing: `!customer` already blocks Save until `customerId` is
            // set, and that only happens inside the same load callback that
            // sets `loaded` — so there is no render where the form looks
            // populated but `loaded` is still null. `editing && !loaded` is
            // belt-and-braces alongside that check, not what closes the
            // race: it mirrors CustomerModal's own Save gate on
            // `pricesLoaded`, so an edit stays fail-closed even if the
            // `!customer` check above it ever changes shape.
            disabled={busy || !customer || usable.length === 0 || (editing && !loaded)}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save order'}
          </button>
        </div>
      </div>
    </div>
  )
}
