'use client'

import { useEffect, useRef, useState } from 'react'
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
  connectionLabel: string | null
  lastSyncAt: string | null
  lastError: string | null
}

type ShopOption = { id: string; name: string }

export type PlatformSetup = {
  meta: { clientId: string } | null
  google: { clientId: string; hasDeveloperToken: boolean } | null
}

const PROVIDER_LABEL: Record<string, string> = { meta: 'Meta', google: 'Google' }

const field = 'mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm'
const label = 'mt-3 block text-xs font-medium text-muted'
const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90'
const quietBtn =
  'rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

export function AdAccountsClient({
  email,
  shops,
  accounts,
  platform,
  picker,
  initialError,
  initialNotice,
}: {
  email: string
  shops: ShopOption[]
  accounts: Row[]
  platform: PlatformSetup
  picker: string | null
  initialError: string | null
  initialNotice: string | null
}) {
  const router = useRouter()
  const [manualOpen, setManualOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [pickerId, setPickerId] = useState(picker)
  const [syncing, setSyncing] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const toast = useToast()

  // The OAuth callback lands with words in the URL exactly once.
  const greeted = useRef(false)
  useEffect(() => {
    if (greeted.current) return
    greeted.current = true
    if (initialError) toast.error(initialError)
    if (initialNotice) toast.success(initialNotice)
  }, [initialError, initialNotice, toast])

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

  function closePicker() {
    setPickerId(null)
    // Drop ?picker= so a refresh does not reopen a finished flow.
    router.replace('/settings/ad-accounts')
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Ad accounts"
        subtitle="Press connect, log in, tick the ad accounts you want, done. Daily spend then syncs itself a few times a day and lands on the Marketing page, shop by shop."
      >
        <div className="flex flex-wrap items-center gap-2">
          <ConnectButton provider="meta" ready={Boolean(platform.meta)} />
          <ConnectButton
            provider="google"
            ready={Boolean(platform.google && platform.google.hasDeveloperToken)}
          />
          <button
            onClick={syncNow}
            disabled={syncing}
            title="Everything arrives by itself; this just asks the platforms right now."
            className={quietBtn}
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
                    Nothing connected yet. Fill in the platform setup below once, then press
                    “Connect with Facebook” or “Connect with Google”.
                  </td>
                </tr>
              )}
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-line">
                  <td className="px-3 py-2.5 font-medium text-ink">
                    {a.name}
                    {a.connectionLabel && (
                      <span className="block text-[11px] font-normal text-faint">
                        via {a.connectionLabel}
                      </span>
                    )}
                  </td>
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

        <button
          onClick={() => setManualOpen(true)}
          className="mt-3 text-xs font-medium text-muted hover:text-ink hover:underline"
        >
          Advanced: paste credentials manually
        </button>

        <PlatformSetupSection platform={platform} />
      </PageBody>

      {pickerId && (
        <PickerModal
          connectionId={pickerId}
          shops={shops}
          onClose={closePicker}
          onSaved={() => {
            closePicker()
            router.refresh()
          }}
        />
      )}

      {(manualOpen || editing) && (
        <AccountModal
          shops={shops}
          existing={editing}
          onClose={() => {
            setManualOpen(false)
            setEditing(null)
          }}
          onSaved={() => {
            setManualOpen(false)
            setEditing(null)
            router.refresh()
          }}
        />
      )}
    </AppShell>
  )
}

function ConnectButton({ provider, ready }: { provider: 'meta' | 'google'; ready: boolean }) {
  const toast = useToast()
  const text = provider === 'meta' ? 'Connect with Facebook' : 'Connect with Google'
  if (!ready) {
    // A button that cannot be pressed and cannot say why is a dead end.
    // Pressing this one explains itself and walks to the setup.
    return (
      <button
        onClick={() => {
          toast.error('One-time setup needed first. Two minutes, the steps are right below.')
          document.getElementById('platform-setup')?.scrollIntoView?.({ behavior: 'smooth' })
        }}
        className={quietBtn}
      >
        {text}
      </button>
    )
  }
  return (
    <a href={`/api/ads/oauth/${provider}/start`} className={primaryBtn}>
      {text}
    </a>
  )
}

type Pickable = {
  externalId: string
  name: string
  currency: string
  loginCustomerId?: string
  alreadyConnected: boolean
  suggestedShopId: string | null
}

function PickerModal({
  connectionId,
  shops,
  onClose,
  onSaved,
}: {
  connectionId: string
  shops: ShopOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [who, setWho] = useState('')
  const [rows, setRows] = useState<
    (Pickable & { checked: boolean; shopId: string })[]
  >([])
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`/api/ads/connections/${connectionId}/accounts`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not list the accounts')
        return res.json()
      })
      .then((json: { label: string; accounts: Pickable[] }) => {
        setWho(json.label)
        setRows(
          json.accounts.map((a) => ({
            ...a,
            // A confident name match starts ticked; everything else waits.
            checked: !a.alreadyConnected && a.suggestedShopId !== null,
            shopId: a.suggestedShopId ?? shops[0]?.id ?? '',
          })),
        )
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [connectionId, shops])

  async function save() {
    const picked = rows.filter((r) => r.checked && !r.alreadyConnected)
    if (picked.length === 0) {
      toast.error('Tick at least one account')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/ad-accounts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId,
          accounts: picked.map((r) => ({
            externalId: r.externalId,
            name: r.name,
            currency: r.currency,
            shopId: r.shopId,
            ...(r.loginCustomerId ? { loginCustomerId: r.loginCustomerId } : {}),
          })),
        }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not connect the accounts')
        return
      }
      const data = (await res.json()) as { results: { ok: boolean }[] }
      toast.success(
        `Connected ${data.results.filter((r) => r.ok).length} account(s). History is importing.`,
      )
      onSaved()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink">Pick the ad accounts</h2>
        <p className="mt-1 text-xs text-muted">
          {who ? `Logged in as ${who}. ` : ''}Tick the accounts to track and say which shop each
          one advertises for. The shop is guessed from the name where it is obvious.
        </p>

        {loading && <p className="mt-4 text-sm text-muted">Asking the platform…</p>}
        {error && <p className="mt-4 text-sm text-loss">{error}</p>}

        {!loading && !error && (
          <div className="mt-4 space-y-2">
            {rows.length === 0 && (
              <p className="text-sm text-muted">This login can see no ad accounts.</p>
            )}
            {rows.map((row, i) => (
              <div
                key={row.externalId}
                className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
              >
                <input
                  type="checkbox"
                  aria-label={row.name}
                  checked={row.checked || row.alreadyConnected}
                  disabled={row.alreadyConnected}
                  onChange={() =>
                    setRows((prev) =>
                      prev.map((r, j) => (j === i ? { ...r, checked: !r.checked } : r)),
                    )
                  }
                  className="h-4 w-4"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{row.name}</p>
                  <p className="text-[11px] text-faint">
                    {row.externalId} · {row.currency}
                    {row.alreadyConnected ? ' · already connected' : ''}
                  </p>
                </div>
                {!row.alreadyConnected && (
                  <select
                    value={row.shopId}
                    aria-label={`Shop for ${row.name}`}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, j) => (j === i ? { ...r, shopId: e.target.value } : r)),
                      )
                    }
                    className="rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-xs"
                  >
                    {shops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
            Close
          </button>
          <button
            onClick={save}
            disabled={busy || loading}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Connecting…' : 'Connect ticked accounts'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PlatformSetupSection({ platform }: { platform: PlatformSetup }) {
  return (
    <section id="platform-setup" className="mt-8">
      <h2 className="text-[13px] font-semibold text-ink">Platform setup</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        A one-time step per platform: create your own app, paste its keys here, and the connect
        buttons above come alive. Only you ever log in through it, so no app review is needed.
      </p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <PlatformCard provider="meta" saved={platform.meta} />
        <PlatformCard provider="google" saved={platform.google} />
      </div>
    </section>
  )
}

function PlatformCard({
  provider,
  saved,
}: {
  provider: 'meta' | 'google'
  saved: { clientId: string; hasDeveloperToken?: boolean } | null
}) {
  const router = useRouter()
  const [clientId, setClientId] = useState(saved?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [developerToken, setDeveloperToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState('')
  const toast = useToast()

  // The origin only exists in the browser; setting it after mount avoids a
  // hydration mismatch between the server's empty string and the real URL.
  const [origin, setOrigin] = useState('')
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin)
  }, [])
  const redirectUri = origin ? `${origin}/api/ads/oauth/${provider}/callback` : ''

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/ad-platform-apps', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, clientId, clientSecret, developerToken }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string; warning?: string } | null
      if (!res.ok) {
        toast.error(body?.error ?? 'Could not save')
        return
      }
      // The warning outlives the toast: it stays until the next save fixes it.
      setWarning(body?.warning ?? '')
      toast.success(`${provider === 'meta' ? 'Meta' : 'Google'} setup saved`)
      router.refresh()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">
        {provider === 'meta' ? 'Meta app' : 'Google app'}
      </h3>
      {provider === 'meta' ? (
        <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-muted">
          <li>developers.facebook.com: Create app, Business type.</li>
          <li>
            Paste the App ID and App secret here and press Save. Saving adds this site to the
            app&apos;s domains for you.
          </li>
          <li>
            Add the Facebook Login product, then Facebook Login, Settings: paste the callback URL
            below under Valid OAuth Redirect URIs.
          </li>
          <li>Keep the app in Development mode. Only you log in, so no review is needed.</li>
        </ol>
      ) : (
        <p className="mt-1 text-[11px] text-muted">
          console.cloud.google.com, Credentials, OAuth client (Web application) with the callback
          URL below. Set the consent screen to In production. The developer token comes from
          Google Ads, manager account, API Center.
        </p>
      )}
      <p className="mt-2 break-all rounded-[var(--radius-control)] bg-panel px-2 py-1.5 text-[11px] text-ink">
        <span className="text-faint">Callback URL: </span>
        {redirectUri || '…'}
      </p>

      {warning && (
        <p className="mt-2 rounded-[var(--radius-control)] border border-line bg-panel px-2 py-1.5 text-[11px] font-medium text-loss">
          {warning}
        </p>
      )}

      <label className={label}>{provider === 'meta' ? 'App ID' : 'Client ID'}</label>
      <input
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        aria-label={`${provider} client id`}
        className={field}
      />

      <label className={label}>{provider === 'meta' ? 'App secret' : 'Client secret'}</label>
      <input
        type="password"
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
        placeholder={saved ? 'saved, leave blank to keep' : ''}
        aria-label={`${provider} client secret`}
        className={field}
      />

      {provider === 'google' && (
        <>
          <label className={label}>Developer token</label>
          <input
            type="password"
            value={developerToken}
            onChange={(e) => setDeveloperToken(e.target.value)}
            placeholder={saved?.hasDeveloperToken ? 'saved, leave blank to keep' : ''}
            aria-label="google developer token"
            className={field}
          />
        </>
      )}

      <div className="mt-4 flex justify-end">
        <button onClick={save} disabled={busy} className={quietBtn}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

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
  // An account connected by login needs no pasted credentials; editing it is
  // only about which shop it belongs to.
  const viaConnection = Boolean(existing?.connectionLabel)

  async function save() {
    setBusy(true)
    try {
      const body = existing
        ? viaConnection
          ? { shopId }
          : { shopId, accessToken, developerToken, clientId, clientSecret, refreshToken, loginCustomerId }
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
        {!viaConnection && (
          <p className="mt-1 text-xs text-muted">
            {provider === 'meta'
              ? 'In Meta Business settings: System users → generate a token with ads_read. The account ID is under Ad accounts.'
              : 'From Google Ads: the customer ID (top right), a developer token (manager account → API Center), and OAuth credentials.'}
          </p>
        )}

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

        {!viaConnection &&
          (provider === 'meta' ? (
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
          ))}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : existing ? 'Save' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
