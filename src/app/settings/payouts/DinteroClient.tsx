'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

/**
 * Where the client connects each webshop to its Dintero account.
 *
 * One card per shop, because each webshop is paid out on its own. The
 * credentials are typed once and never come back: the server proves them
 * against Dintero, stores them encrypted, and every answer this page reads
 * is the public status shape - same discipline as the Klaviyo page.
 */

export type ShopStatus = {
  shopId: string
  name: string
  currency: string
  connected: boolean
  accountId: string | null
  payoutDestinationId: string | null
  lastSyncAt: string | null
  lastError: string | null
  payouts: number
}

type Payload = { shops: ShopStatus[] }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'
const quietBtn =
  'rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'
const field =
  'rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm'

function ConnectForm({ shop, onDone }: { shop: ShopStatus; onDone: () => void }) {
  const [accountId, setAccountId] = useState(shop.accountId ?? '')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [payoutDestinationId, setPayoutDestinationId] = useState(shop.payoutDestinationId ?? '')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const ready = /^[PT]\d{8}$/.test(accountId.trim()) && clientId.trim().length >= 4 && clientSecret.trim().length >= 4

  async function connect() {
    setBusy(true)
    try {
      const res = await fetch('/api/dintero/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId: shop.shopId,
          accountId: accountId.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          ...(payoutDestinationId.trim() ? { payoutDestinationId: payoutDestinationId.trim() } : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // Keep what they pasted: a rejected secret is usually a mistyped one.
        toast.error(json?.error ?? 'Could not connect')
        return
      }
      toast.success(
        json.sync?.ok
          ? `${shop.name} connected - ${json.sync.payouts} payouts imported`
          : `${shop.name} connected, but the first import failed. See the status on the card.`,
      )
      onDone()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="Account ID (P12345678)"
          aria-label={`Account ID for ${shop.name}`}
          className={`w-52 ${field}`}
        />
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          aria-label={`Client ID for ${shop.name}`}
          className={`w-72 ${field}`}
        />
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Client Secret"
          aria-label={`Client Secret for ${shop.name}`}
          className={`w-72 ${field}`}
        />
        <button type="button" onClick={connect} disabled={busy || !ready} className={primaryBtn}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted">
          One Dintero account paying out several shops?
        </summary>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={payoutDestinationId}
            onChange={(e) => setPayoutDestinationId(e.target.value)}
            placeholder="Payout destination ID (optional)"
            aria-label={`Payout destination ID for ${shop.name}`}
            className={`w-72 ${field}`}
          />
          <span className="text-xs text-muted">Only needed to split one account per shop.</span>
        </div>
      </details>
    </div>
  )
}

export function DinteroClient({ email }: { email: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [openShop, setOpenShop] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const toast = useToast()

  useEffect(() => {
    const ctrl = new AbortController()
    fetch('/api/dintero/config', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the Dintero connections'))))
      .then((body: Payload) => {
        setData(body)
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctrl.abort()
  }, [nonce])

  async function disconnect(shop: ShopStatus) {
    if (
      !window.confirm(
        `Disconnect ${shop.name} from Dintero? The imported payout history stays; only the credentials are removed.`,
      )
    )
      return
    try {
      const res = await fetch(`/api/dintero/config?shopId=${encodeURIComponent(shop.shopId)}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error('Could not disconnect')
        return
      }
      toast.success(`${shop.name} disconnected`)
      setNonce((n) => n + 1)
    } catch {
      toast.error('Could not reach the server')
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Payouts (Dintero)"
        subtitle="Connect each webshop's Dintero account. Every weekly payout is then matched to the exact orders behind it, automatically."
      />
      <PageBody>
        {error ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[13px] text-loss">
            {error}
          </div>
        ) : !data ? (
          <div className="skeleton h-[240px] w-full" style={{ borderRadius: 'var(--radius-card)' }} />
        ) : (
          <div className="space-y-3">
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
              <h2 className="text-sm font-semibold text-ink">How to connect a shop</h2>
              <p className="mt-1 max-w-2xl text-xs text-muted">
                In Dintero Backoffice, pick the account that pays out this webshop. Go to Settings →
                API &amp; Integrations → API clients and create a new API client with read access to
                settlements. Copy the Account ID (a P followed by eight digits), the Client ID and
                the Client Secret, and paste them on the shop&apos;s card below. They are checked
                against Dintero before anything is stored, then kept encrypted and never shown
                again.
              </p>
            </section>

            {data.shops.map((shop) => (
              <section key={shop.shopId} className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">
                      {shop.name} <span className="font-normal text-faint">· {shop.currency}</span>
                    </h2>
                    {shop.connected ? (
                      <>
                        <p className="mt-1 text-xs text-muted">
                          {shop.accountId} · {shop.payouts.toLocaleString('en-US')} payouts imported ·
                          last sync {when(shop.lastSyncAt)}
                        </p>
                        {shop.lastError ? (
                          <p className="mt-1 max-w-2xl text-xs text-loss">
                            <span className="font-semibold">Last sync failed.</span> {shop.lastError}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-gain">OK</p>
                        )}
                      </>
                    ) : (
                      <p className="mt-1 text-xs text-muted">Not connected.</p>
                    )}
                  </div>
                  {shop.connected ? (
                    <button
                      type="button"
                      onClick={() => disconnect(shop)}
                      className="text-[13px] font-semibold text-loss hover:underline"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpenShop(openShop === shop.shopId ? null : shop.shopId)}
                      className={quietBtn}
                    >
                      {openShop === shop.shopId ? 'Close' : 'Connect'}
                    </button>
                  )}
                </div>
                {!shop.connected && openShop === shop.shopId && (
                  <ConnectForm
                    shop={shop}
                    onDone={() => {
                      setOpenShop(null)
                      setNonce((n) => n + 1)
                    }}
                  />
                )}
              </section>
            ))}

            <p className="text-xs text-muted">
              The payouts live on the{' '}
              <Link href="/finance/payouts" className="font-semibold text-accent hover:underline">
                Finance → Payouts
              </Link>{' '}
              tab.
            </p>
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}
