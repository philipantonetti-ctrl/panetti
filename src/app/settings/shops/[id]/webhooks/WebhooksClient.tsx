'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

/** One row as GET /api/diagnostics/woo-webhooks reports it. */
export type Webhook = {
  id: number
  name: string
  topic: string
  status: string // active | paused | disabled
  delivery: string
  ours: boolean
  created: string | null
  modified: string | null
}

/** Woo's topic names, in the words of whoever has to read this page in a hurry. */
const TOPIC_WORDS: Record<string, string> = {
  'order.created': 'New order',
  'order.updated': 'Order changed',
  'order.deleted': 'Order deleted',
  'order.restored': 'Order restored',
  'product.created': 'New product',
  'product.updated': 'Product changed',
  'product.deleted': 'Product deleted',
  'product.restored': 'Product restored',
  'customer.created': 'New customer',
  'customer.updated': 'Customer changed',
  'customer.deleted': 'Customer deleted',
  'coupon.created': 'New coupon',
  'coupon.updated': 'Coupon changed',
  'coupon.deleted': 'Coupon deleted',
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')

export function WebhooksClient({
  email,
  shop,
  webhooks: initial,
  error,
}: {
  email: string
  shop: { id: string; name: string }
  webhooks: Webhook[]
  /** Why the store could not be read, when it could not. */
  error: string | null
}) {
  const toast = useToast()
  const [webhooks, setWebhooks] = useState(initial)
  const [busy, setBusy] = useState<number | null>(null)

  /**
   * Switch one on, then re-read the whole list from the store. The row ends
   * up showing what the store reports, never what we asked for: a store that
   * silently refused the change would otherwise read "On" until the next visit.
   */
  async function switchOn(w: Webhook) {
    setBusy(w.id)
    try {
      const res = await fetch('/api/diagnostics/woo-webhooks/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop.id, webhookId: w.id }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not switch the webhook on')
        return
      }
      const list = await fetch(`/api/diagnostics/woo-webhooks?shopId=${encodeURIComponent(shop.id)}`)
      const body = await list.json().catch(() => null)
      const fresh = body?.shops?.[0]
      if (fresh?.ok) setWebhooks(fresh.webhooks)
      toast.success(`${w.name || w.topic} is on.`)
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader title={`${shop.name} webhooks`} subtitle="Every webhook this store has, and whether it is on." />
      <PageBody>
        <p className="text-xs text-muted">
          <Link href="/settings/shops" className="font-semibold text-accent hover:underline">
            Back to Shops
          </Link>
        </p>

        <p className="mt-4 max-w-2xl text-xs text-muted">
          WooCommerce switches a webhook off by itself after 5 failed deliveries in a row. Switching it on
          here helps new orders only. Orders missed while it was off must be sent again by whoever receives
          the webhook.
        </p>

        {error ? (
          <div className="mt-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-xs">
            <div className="font-semibold text-loss">Could not read this store&apos;s webhooks</div>
            <div className="mt-1 text-muted">{error}</div>
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">What it reports</th>
                  <th className="px-3 py-2.5 font-medium">Sent to</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Last change</th>
                  <th className="px-3 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                {webhooks.length === 0 && (
                  <tr className="border-t border-line">
                    <td colSpan={6} className="px-3 py-6 text-center text-muted">
                      This store has no webhooks.
                    </td>
                  </tr>
                )}
                {webhooks.map((w) => {
                  const on = w.status === 'active'
                  return (
                    <tr key={w.id} className="border-t border-line">
                      <td className="px-3 py-2.5 font-medium text-ink">{w.name || w.topic}</td>
                      <td className="px-3 py-2.5">{TOPIC_WORDS[w.topic] ?? w.topic}</td>
                      <td className="px-3 py-2.5 text-muted">
                        <span className="break-all">{w.delivery}</span>
                        {w.ours && (
                          <span className="ml-2 rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                            this app
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold ${on ? 'text-gain' : 'text-loss'}`}
                        >
                          {on ? 'On' : 'Off'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted">{when(w.modified)}</td>
                      <td className="px-3 py-2.5 text-right">
                        {!on && (
                          <button
                            onClick={() => void switchOn(w)}
                            disabled={busy !== null}
                            className="font-semibold text-accent hover:underline disabled:opacity-60"
                          >
                            {busy === w.id ? 'Switching on…' : 'Switch on'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
