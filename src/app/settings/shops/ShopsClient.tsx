'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TopBar } from '@/components/TopBar'

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
    <div className="min-h-screen bg-slate-50">
      <TopBar email={email} />

      <main className="mx-auto max-w-4xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-900">Shops</h1>
            <p className="mt-1 text-sm text-slate-500">
              Connect each WooCommerce store. Until a store is connected it shows seeded sample data.
            </p>
          </div>
          <button
            onClick={syncAll}
            disabled={syncing}
            className="rounded-lg bg-violet-700 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : '⟳ Sync all'}
          </button>
        </div>

        {message && (
          <div className="mt-4 rounded-lg bg-slate-100 px-4 py-3 text-xs text-slate-700">{message}</div>
        )}

        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-500">
                <th className="px-3 py-2.5 font-medium">Shop</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 font-medium">Connection</th>
                <th className="px-3 py-2.5 font-medium">Last sync</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {shops.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="px-3 py-2.5 font-medium text-slate-900">{s.name}</td>
                  <td className="px-3 py-2.5">{s.currency}</td>
                  <td className="px-3 py-2.5">
                    {s.connected ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                        Connected
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                        Sample data
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-500">
                    {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setEditing(s)} className="font-semibold text-violet-700 hover:underline">
                      {s.connected ? 'Edit' : 'Connect'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

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
    </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold text-slate-900">Connect {shop.name}</h2>
        <p className="mt-1 text-xs text-slate-500">
          In WordPress: WooCommerce → Settings → Advanced → REST API → Add key (Read access).
        </p>

        <label className="mt-4 block text-xs font-medium text-slate-600">Store URL</label>
        <input value={wooUrl} onChange={(e) => setWooUrl(e.target.value)} placeholder="https://mazzetti.no"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-slate-600">Consumer key</label>
        <input value={wooKey} onChange={(e) => setWooKey(e.target.value)} placeholder="ck_…"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <label className="mt-3 block text-xs font-medium text-slate-600">Consumer secret</label>
        <input type="password" value={wooSecret} onChange={(e) => setWooSecret(e.target.value)} placeholder="cs_…"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
