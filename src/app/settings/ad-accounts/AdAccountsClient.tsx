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

/** Whether each platform's app is configured on the server. Nothing more: the
 * client never types these credentials, so the browser never needs to see
 * them. */
export type PlatformSetup = { meta: boolean; google: boolean }

/**
 * The login behind each platform, if there is one.
 *
 * Read from the connections themselves rather than inferred from the accounts,
 * so a login someone made but never ticked an account on still says it exists —
 * which is exactly the state that looks most broken.
 */
export type ConnectionSummary = {
  label: string
  expiresAt: string | null
  /**
   * Decided on the server, where the clock lives. Reading `Date.now()` while
   * rendering is impure — the answer would change under a re-render nobody
   * asked for — and the server is already the thing that knows what time this
   * page was built.
   */
  expired: boolean
}
export type Connections = { meta: ConnectionSummary | null; google: ConnectionSummary | null }

const PROVIDER_LABEL: Record<string, string> = { meta: 'Meta', google: 'Google' }

/** What the person pressing the button calls it, which is not what we call it. */
const PLATFORM_NAME = { meta: 'Facebook', google: 'Google' } as const

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
  connections,
  picker,
  initialError,
  initialNotice,
}: {
  email: string
  shops: ShopOption[]
  accounts: Row[]
  platform: PlatformSetup
  connections: Connections
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
        subtitle="Log in with Facebook or Google, tick the ad accounts you want, done. Daily spend then syncs itself a few times a day and lands on the Marketing page, shop by shop."
      >
        <div className="flex flex-wrap items-center gap-2">
          <ConnectButton provider="meta" ready={platform.meta} />
          <ConnectButton provider="google" ready={platform.google} />
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
        <SignedInAs connections={connections} platform={platform} />

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
                    Nothing connected yet. Press “Connect with Facebook” or “Connect with
                    Google” above.
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

/**
 * Which logins exist, in words, directly under the buttons.
 *
 * The buttons cannot say this themselves: "Connect with Facebook" reads exactly
 * the same whether nothing is connected or nine accounts are, and the only other
 * clue is the small "via" line under each account name. Someone who has just
 * connected is looking at the very button they pressed, so asking "did that
 * work?" is the reasonable reading, not a careless one.
 *
 * A platform with no login says nothing at all. The button already tells that
 * story, and lines reading "not connected" would be noise on a page whose empty
 * table says it too.
 */
function SignedInAs({
  connections,
  platform,
}: {
  connections: Connections
  platform: PlatformSetup
}) {
  const lines = (['meta', 'google'] as const).flatMap((provider) => {
    const conn = connections[provider]
    const name = PLATFORM_NAME[provider]
    const expiry = conn?.expiresAt ? new Date(conn.expiresAt) : null

    // A platform the server cannot log into is the one "not connected" worth
    // printing, and it goes first: the button beside it is disabled, and a
    // disabled control with no stated reason is its own dead end. Said here
    // rather than in a toast because a toast has to be provoked and then
    // leaves — which is how the client came to press the dead button eight
    // times. It also says whose problem it is, so the answer to "what do I do"
    // is "nothing", not "press it again".
    if (!platform[provider]) {
      return [
        <span key={provider} className="block">
          {name}: not connected yet. Setup is on our side, nothing to do here.
        </span>,
      ]
    }

    if (!conn) return []

    // An expired login is the reason every sync for that platform starts
    // failing, so it replaces the reassurance rather than trailing after it.
    if (expiry && conn.expired) {
      return [
        <span key={provider} className="block text-loss">
          {name}: login expired {expiry.toLocaleDateString()}. Press “Connect with {name}” to renew
          it.
        </span>,
      ]
    }

    // Meta tokens last about 60 days; a Google refresh token does not expire
    // while the client stays published, so there is no date to promise.
    return [
      <span key={provider} className="block">
        {name}: connected as {conn.label}.
        {expiry ? ` Renew by ${expiry.toLocaleDateString()}.` : ''}
      </span>,
    ]
  })

  if (!lines.length) return null
  return <div className="mt-4 space-y-1 text-xs text-muted">{lines}</div>
}

function ConnectButton({ provider, ready }: { provider: 'meta' | 'google'; ready: boolean }) {
  const text = provider === 'meta' ? 'Connect with Facebook' : 'Connect with Google'
  if (!ready) {
    // Disabled, not merely inert. This used to be an ordinary enabled button
    // wearing the same class as "Sync now" beside it, which answered every
    // press with a toast and nothing else — so it read as a working control
    // that kept refusing, and the client pressed it eight times in a row.
    // The credentials are server config: a missing one is ours to fix, and
    // SignedInAs above says so in words that stay on the page.
    return (
      <button
        type="button"
        disabled
        title={`${PLATFORM_NAME[provider]} is not set up on the server yet.`}
        className={`${quietBtn} cursor-not-allowed opacity-50`}
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
              // Almost always the wrong Facebook account got the login, so say
              // that rather than leave an empty table looking broken.
              <p className="text-sm text-muted">
                This login can see no ad accounts. Check you logged in with the Facebook account
                that has access to them.
              </p>
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
              {/* Named apart from the card's field above: two identical
                  labels on one page read the same to a screen reader. */}
              <label className={label}>Access token for this account</label>
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
