'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { formatMoney, toMajor } from '@/lib/money'
import { useToast } from '@/components/toast/useToast'
import { CustomerModal } from '../CustomerModal'
import type { Customer } from '../B2bClient'
import type { Shop } from '@/components/filters/ShopFilter'

type PriceRow = {
  productId: string
  sku: string
  name: string
  imageUrl: string | null
  /** Customer currency. */
  unitPrice: number
  /** Both in the SHOP's currency. */
  costPerItem: number
  handlingCost: number
}

type Detail = Customer & { shopCurrency: string; canChangeShop: boolean; prices: PriceRow[] }

export function CustomerClient({
  email,
  customerId,
  shops,
}: {
  email: string
  customerId: string
  shops: Shop[]
}) {
  const toast = useToast()
  const [customer, setCustomer] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    fetch(`/api/b2b/customers/${customerId}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (!r.ok) {
          setLoadError(d?.error ?? 'Could not load the customer')
          return
        }
        setCustomer(d.customer)
      })
      .catch(() => setLoadError('Could not reach the server'))
      .finally(() => setLoading(false))
  }, [customerId])

  useEffect(load, [load])

  async function setActive(active: boolean) {
    if (!customer) return
    const res = await fetch(`/api/b2b/customers/${customer.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customer.name, currency: customer.currency, vatPercent: customer.vatPercent,
        email: customer.email, note: customer.note, active,
        // Back to major units - the shape the route takes.
        prices: customer.prices.map((p) => ({
          productId: p.productId,
          unitPrice: toMajor(p.unitPrice),
        })),
      }),
    }).catch(() => null)

    if (!res?.ok) {
      toast.error('Could not change that')
      return
    }
    toast.success(active ? 'Customer reactivated' : 'Customer deactivated')
    load()
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title={customer?.name ?? 'Business customer'}
        subtitle={
          customer
            ? `${customer.shopName} · invoiced in ${customer.currency} · VAT ${customer.vatPercent}%`
            : undefined
        }
      >
        <Link
          href="/b2b"
          className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
        >
          Back to B2B
        </Link>
        {customer && (
          <>
            <Link
              href={`/orders?source=b2b&q=${encodeURIComponent(customer.name)}`}
              className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
            >
              Their orders
            </Link>
            <button
              onClick={() => setEditing(true)}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90"
            >
              Edit
            </button>
            <button
              onClick={() => setActive(!customer.active)}
              className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-[13px] text-ink hover:bg-panel"
            >
              {customer.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </>
        )}
      </PageHeader>

      <PageBody>
        {loading ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-faint">{loadError}</p>
        ) : !customer ? null : (
          <>
            <div className="flex divide-x divide-line rounded-[var(--radius-card)] border border-line bg-surface">
              {[
                ['Orders', String(customer.orderCount)],
                ['Revenue', formatMoney(customer.revenue, customer.currency)],
                ['Agreed prices', String(customer.priceCount)],
              ].map(([label, value]) => (
                <div key={label} className="flex-1 px-5 py-4">
                  <p className="text-[11px] font-medium text-muted">{label}</p>
                  <p className="num mt-1 text-lg font-semibold text-ink">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[var(--radius-card)] border border-line bg-surface p-4">
              <p className="pb-3 text-sm text-ink">Agreed prices</p>

              <div className="overflow-x-auto">
                <table className="w-full whitespace-nowrap text-xs">
                  <thead>
                    <tr className="bg-panel text-left text-muted">
                      <th className="px-3 py-2.5 font-medium">Product</th>
                      <th className="px-3 py-2.5 font-medium">SKU</th>
                      {/* Two currencies, so both columns name theirs. They are
                          not comparable at a glance and must not pretend to be. */}
                      <th className="px-3 py-2.5 text-right font-medium">
                        Our cost ({customer.shopCurrency})
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">
                        Agreed price ({customer.currency})
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-ink">
                    {customer.prices.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-3 py-10 text-center text-faint">
                          <span className="font-semibold text-ink">No agreed prices yet</span> - add
                          some with Edit, or type a price when you enter their first order.
                        </td>
                      </tr>
                    ) : (
                      customer.prices.map((p) => (
                        <tr key={p.productId} className="border-t border-line">
                          <td className="px-3 py-3 font-medium text-ink">{p.name}</td>
                          <td className="px-3 py-3 text-muted">{p.sku}</td>
                          <td className="num px-3 py-3 text-right text-muted">
                            {p.costPerItem === 0 ? (
                              <span className="text-warn" title="No cost entered for this product">
                                not set
                              </span>
                            ) : (
                              formatMoney(p.costPerItem + p.handlingCost, customer.shopCurrency)
                            )}
                          </td>
                          <td className="num px-3 py-3 text-right font-medium text-ink">
                            {formatMoney(p.unitPrice, customer.currency)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </PageBody>

      {editing && customer && (
        <CustomerModal
          shops={shops}
          customer={customer}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load() }}
        />
      )}
    </AppShell>
  )
}
