'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'

type Row = {
  id: string
  name: string
  currency: string
  wooUrl: string
  connected: boolean
  lastSyncAt: string | null
}

export function ShopsClient({ email, shops }: { email: string; shops: Row[] }) {
  const router = useRouter()
  const [editing, setEditing] = useState<Row | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')

  async function syncAll() {
    setSyncing(true)
    setMessage('')
    const res = await fetch('/api/sync', { method: 'POST' })
    const data = await res.json()

    const results: { shopName: string; ok: boolean; ordersSynced: number; error?: string }[] = data.results ?? []
    const good = results.filter((r) => r.ok)
    const bad = results.filter((r) => !r.ok)

    setMessage(
      `Synced ${good.reduce((n, r) => n + r.ordersSynced, 0)} orders from ${good.length} shop(s).` +
        (bad.length ? ` Failed: ${bad.map((r) => `${r.shopName} (${r.error})`).join(', ')}` : ''),
    )
    setSyncing(false)
    router.refresh()
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Shops"
        subtitle="Connect each WooCommerce store. Until a store is connected it shows sample data."
      >
        <button
          onClick={syncAll}
          disabled={syncing}
          className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {syncing ? 'Syncing…' : 'Sync all'}
        </button>
      </PageHeader>

      <PageBody>

        {message && (
          <div className="mt-4 rounded-[var(--radius-control)] bg-panel px-4 py-3 text-xs text-ink">{message}</div>
        )}

        <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-panel text-left text-muted">
                <th className="px-3 py-2.5 font-medium">Shop</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 font-medium">Connection</th>
                <th className="px-3 py-2.5 font-medium">Last sync</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-ink">
              {shops.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-3 py-2.5 font-medium text-ink">{s.name}</td>
                  <td className="px-3 py-2.5">{s.currency}</td>
                  <td className="px-3 py-2.5">
                    {s.connected ? (
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-gain">
                        Connected
                      </span>
                    ) : (
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                        Sample data
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setEditing(s)} className="font-semibold text-accent hover:underline">
                      {s.connected ? 'Edit' : 'Connect'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageBody>

      {editing && (
        <ConnectModal
          shop={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      )}
    </AppShell>
  )
}

function ConnectModal({ shop, onClose, onSaved }: { shop: Row; onClose: () => void; onSaved: () => void }) {
  const [wooUrl, setWooUrl] = useState(shop.wooUrl)
  const [wooKey, setWooKey] = useState('')
  const [wooSecret, setWooSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    await fetch(`/api/shops/${shop.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wooUrl, wooKey, wooSecret }),
    })
    setBusy(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[var(--radius-card)] bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-ink">Connect {shop.name}</h2>
        <p className="mt-1 text-xs text-muted">
          In WordPress: WooCommerce → Settings → Advanced → REST API → Add key (Read access).
        </p>

        <label className="mt-4 block text-xs font-medium text-muted">Store URL</label>
        <input value={wooUrl} onChange={(e) => setWooUrl(e.target.value)} placeholder="https://mazzetti.no"
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-muted">Consumer key</label>
        <input value={wooKey} onChange={(e) => setWooKey(e.target.value)} placeholder="ck_…"
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-muted">Consumer secret</label>
        <input type="password" value={wooSecret} onChange={(e) => setWooSecret(e.target.value)} placeholder="cs_…"
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm" />

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
