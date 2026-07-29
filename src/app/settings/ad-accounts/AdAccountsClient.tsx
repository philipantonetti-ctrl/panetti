'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

export type Row = {
  id: string
  provider: string
  externalId: string
  name: string
  currency: string
  shopId: string
  shopName: string
  lastSyncAt: string | null
  lastError: string | null
}

type ShopOption = { id: string; name: string }

const PROVIDER_LABEL: Record<string, string> = { meta: 'Meta', google: 'Google' }

export function AdAccountsClient({
  email,
  shops,
  accounts,
}: {
  email: string
  shops: ShopOption[]
  accounts: Row[]
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const toast = useToast()

  async function remove(account: Row) {
    if (!window.confirm(`Remove ${account.name}? Its synced spend history goes with it.`)) return
    setDeleting(account.id)
    try {
      const res = await fetch(`/api/ad-accounts/${account.id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not remove the account')
        return
      }
      toast.success(`${account.name} removed`)
      router.refresh()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setDeleting(null)
    }
  }

  async function syncNow() {
    setSyncing(true)
    setMessage('')
    try {
      const res = await fetch('/api/ads/sync', { method: 'POST' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      const data = await res.json()
      const results: { name: string; ok: boolean; days: number; error?: string }[] =
        data.results ?? []
      const good = results.filter((r) => r.ok)
      const bad = results.filter((r) => !r.ok)
      setMessage(
        `Synced ${good.length} account(s).` +
          (bad.length ? ` Failed: ${bad.map((r) => `${r.name} (${r.error})`).join(', ')}` : ''),
      )
      router.refresh()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Ad accounts"
        subtitle="Connect your Meta and Google ad accounts once. Daily spend then syncs itself a few times a day and lands on the Marketing page, shop by shop."
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding(true)}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
          >
            Connect account
          </button>
          <button
            onClick={syncNow}
            disabled={syncing}
            title="Everything arrives by itself; this just asks the platforms right now."
            className="rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </PageHeader>

      <PageBody>
        {message && (
          <div className="mt-4 rounded-[var(--radius-control)] bg-panel px-4 py-3 text-xs text-ink">
            {message}
          </div>
        )}

        <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-panel text-left text-muted">
                <th className="px-3 py-2.5 font-medium">Account</th>
                <th className="px-3 py-2.5 font-medium">Platform</th>
                <th className="px-3 py-2.5 font-medium">Shop</th>
                <th className="px-3 py-2.5 font-medium">Currency</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Last sync</th>
                <th className="px-3 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {accounts.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={7} className="px-3 py-8 text-center text-muted">
                    Nothing connected yet. Press “Connect account” and paste the credentials
                    from Meta Business or Google Ads.
                  </td>
                </tr>
              )}
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className="px-3 py-2.5 font-medium text-ink">{a.name}</td>
                  <td className="px-3 py-2.5">{PROVIDER_LABEL[a.provider] ?? a.provider}</td>
                  <td className="px-3 py-2.5">{a.shopName}</td>
                  <td className="px-3 py-2.5">{a.currency}</td>
                  <td className="px-3 py-2.5">
                    {a.lastError ? (
                      <span
                        title={a.lastError}
                        className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-loss"
                      >
                        Error
                      </span>
                    ) : a.lastSyncAt ? (
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-gain">
                        Connected
                      </span>
                    ) : (
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                        Never synced
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {a.lastSyncAt ? new Date(a.lastSyncAt).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={() => setEditing(a)}
                        className="font-semibold text-accent hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void remove(a)}
                        disabled={deleting !== null}
                        className="font-semibold text-loss hover:underline disabled:opacity-60"
                      >
                        {deleting === a.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageBody>

      {(adding || editing) && (
        <AccountModal
          shops={shops}
          existing={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={() => {
            setAdding(false)
            setEditing(null)
            router.refresh()
          }}
        />
      )}
    </AppShell>
  )
}

const field =
  'mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm'
const label = 'mt-3 block text-xs font-medium text-muted'

function AccountModal({
  shops,
  existing,
  onClose,
  onSaved,
}: {
  shops: ShopOption[]
  existing: Row | null
  onClose: () => void
  onSaved: () => void
}) {
  const [provider, setProvider] = useState<'meta' | 'google'>(
    existing?.provider === 'google' ? 'google' : 'meta',
  )
  const [shopId, setShopId] = useState(existing?.shopId ?? shops[0]?.id ?? '')
  const [externalId, setExternalId] = useState(existing?.externalId ?? '')
  const [accessToken, setAccessToken] = useState('')
  const [developerToken, setDeveloperToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [loginCustomerId, setLoginCustomerId] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const keep = existing ? 'saved, leave blank to keep' : ''

  async function save() {
    setBusy(true)
    try {
      const body = existing
        ? { shopId, accessToken, developerToken, clientId, clientSecret, refreshToken, loginCustomerId }
        : { shopId, provider, externalId, accessToken, developerToken, clientId, clientSecret, refreshToken, loginCustomerId }
      const res = await fetch(existing ? `/api/ad-accounts/${existing.id}` : '/api/ad-accounts', {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        // Keep the modal open: what they pasted is still in it, and closing
        // would say the account is connected when it is not.
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the account')
        return
      }
      toast.success(existing ? 'Account updated' : 'Account connected. First year of spend imported.')
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false) // always — the button must never stick on "Saving…"
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink">
          {existing ? `Edit ${existing.name}` : 'Connect ad account'}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {provider === 'meta'
            ? 'In Meta Business settings: System users → generate a token with ads_read. The account ID is under Ad accounts.'
            : 'From Google Ads: the customer ID (top right), a developer token (manager account → API Center), and OAuth credentials.'}
        </p>

        {!existing && (
          <div className="mt-4 flex gap-1 rounded-[var(--radius-control)] bg-panel p-1" role="tablist">
            {(['meta', 'google'] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={provider === p}
                onClick={() => setProvider(p)}
                className={`flex-1 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-semibold transition-colors duration-150 ${
                  provider === p ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
        )}

        <label className={label}>Shop</label>
        <select value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop" className={field}>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {!existing && (
          <>
            <label className={label}>{provider === 'meta' ? 'Ad account ID' : 'Customer ID'}</label>
            <input
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder={provider === 'meta' ? 'act_1234567890 or just the number' : '123-456-7890'}
              className={field}
            />
          </>
        )}

        {provider === 'meta' ? (
          <>
            <label className={label}>System user access token</label>
            <input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={keep || 'EAAB…'}
              className={field}
            />
          </>
        ) : (
          <>
            <label className={label}>Developer token</label>
            <input
              type="password"
              value={developerToken}
              onChange={(e) => setDeveloperToken(e.target.value)}
              placeholder={keep || 'from the API Center'}
              className={field}
            />
            <label className={label}>OAuth client ID</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={keep || '….apps.googleusercontent.com'}
              className={field}
            />
            <label className={label}>OAuth client secret</label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={keep || 'GOCSPX-…'}
              className={field}
            />
            <label className={label}>Refresh token</label>
            <input
              type="password"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder={keep || '1//…'}
              className={field}
            />
            <label className={label}>Manager account ID (optional)</label>
            <input
              value={loginCustomerId}
              onChange={(e) => setLoginCustomerId(e.target.value)}
              placeholder={keep || 'only when access goes through an MCC'}
              className={field}
            />
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Connecting…' : existing ? 'Save' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
