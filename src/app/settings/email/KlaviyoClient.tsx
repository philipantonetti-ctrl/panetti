'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

/**
 * Where the client pastes the Klaviyo Private API Key.
 *
 * The key is typed once and never comes back: the server proves it against
 * Klaviyo, stores it encrypted, and every answer this page reads is the
 * public status shape, which has no key field at all. Same discipline as the
 * Addrevenue page beside it.
 */

export type KlaviyoStatus = {
  connected: boolean
  currency?: string
  active?: boolean
  hasOrderMetric?: boolean
  lastSyncAt?: string | null
  lastError?: string | null
  campaigns?: number
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'Never')

const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'
const quietBtn =
  'rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

export function KlaviyoClient({ email, initialStatus }: { email: string; initialStatus: KlaviyoStatus }) {
  const [status, setStatus] = useState(initialStatus)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const toast = useToast()

  async function reload() {
    const res = await fetch('/api/klaviyo/config')
    if (res.ok) setStatus((await res.json()) as KlaviyoStatus)
  }

  async function connect() {
    setBusy(true)
    try {
      const res = await fetch('/api/klaviyo/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // Keep what they pasted: a rejected key is usually a mistyped one.
        toast.error(json?.error ?? 'Could not connect')
        return
      }
      setApiKey('')
      toast.success(
        json.sync?.ok
          ? `Klaviyo connected - ${json.sync.campaigns} campaigns imported`
          : 'Klaviyo connected, but the first import failed. See the status below.',
      )
      await reload()
    } catch {
      toast.error('Could not reach the server')
      await reload().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/klaviyo/sync', { method: 'POST' })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(json?.error ?? 'Sync failed')
        return
      }
      if (json.ok) toast.success('Email campaigns refreshed')
      else toast.error(json.error ?? 'Sync failed - see the status below.')
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        'Disconnect Klaviyo? The imported campaign figures are removed with it. Reconnecting imports them again.',
      )
    )
      return
    setBusy(true)
    try {
      const res = await fetch('/api/klaviyo/config', { method: 'DELETE' })
      if (!res.ok) {
        toast.error('Could not disconnect')
        return
      }
      toast.success('Klaviyo disconnected')
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Email (Klaviyo)"
        subtitle="Campaign analytics read straight from the Klaviyo account: recipients, opens, clicks and revenue. Everything syncs itself a few times a day."
      >
        {status.connected && (
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            title="Everything arrives by itself; this just asks Klaviyo right now."
            className={quietBtn}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </PageHeader>

      <PageBody>
        {!status.connected ? (
          <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Connect Klaviyo</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted">
              In Klaviyo go to Settings → Account → API Keys and create a Private API Key with
              read access (Accounts, Campaigns and Metrics). Paste it here - it is checked against
              Klaviyo before anything is stored, then kept encrypted and never shown again.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Private API Key (pk_...)"
                aria-label="Private API Key"
                className="w-80 rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={connect}
                disabled={busy || apiKey.trim().length < 10}
                className={primaryBtn}
              >
                {busy ? 'Checking…' : 'Connect'}
              </button>
            </div>
          </section>
        ) : (
          <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Connected</h2>
                <p className="mt-1 text-xs text-muted">
                  {status.campaigns?.toLocaleString('en-US') ?? 0} campaigns imported · reporting in{' '}
                  {status.currency} · last sync {when(status.lastSyncAt)}
                </p>
                {status.lastError ? (
                  <p className="mt-2 max-w-2xl text-xs text-loss">
                    <span className="font-semibold">Last sync failed.</span> {status.lastError}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-gain">OK</p>
                )}
                {status.hasOrderMetric === false && (
                  <p className="mt-2 max-w-2xl text-xs text-muted">
                    This account has no Placed Order metric, so revenue cannot be attributed to
                    campaigns - opens and clicks still are.
                  </p>
                )}
              </div>
              <button type="button" onClick={disconnect} disabled={busy} className="font-semibold text-loss hover:underline disabled:opacity-60 text-[13px]">
                Disconnect
              </button>
            </div>
            <p className="mt-3 text-xs text-muted">
              The figures live on the{' '}
              <Link href="/marketing/email" className="font-semibold text-accent hover:underline">
                Marketing → Email
              </Link>{' '}
              tab.
            </p>
          </section>
        )}
      </PageBody>
    </AppShell>
  )
}
