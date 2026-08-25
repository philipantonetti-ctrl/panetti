'use client'

import { useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'
import type { PublicAffiliateAccount } from '@/lib/affiliate/accounts'

/**
 * Where the client pastes an Addrevenue brand token.
 *
 * The token is typed once and never comes back: the server proves it against
 * Addrevenue, stores it encrypted, and every answer this page reads is the
 * public shape, which has no token field at all.
 */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

const primaryBtn =
  'rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'
const quietBtn =
  'rounded-[var(--radius-control)] border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-ink transition-opacity duration-150 hover:opacity-90 disabled:opacity-60'

export function AffiliateClient({
  email,
  initialAccounts,
}: {
  email: string
  initialAccounts: PublicAffiliateAccount[]
}) {
  const [accounts, setAccounts] = useState(initialAccounts)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const toast = useToast()

  async function reload() {
    const res = await fetch('/api/affiliate/accounts')
    if (res.ok) setAccounts((await res.json()).accounts as PublicAffiliateAccount[])
  }

  async function add() {
    setBusy(true)
    try {
      const res = await fetch('/api/affiliate/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        // Keep what they pasted: a rejected token is usually a mistyped one,
        // and clearing the box would make them fetch it from Addrevenue again.
        toast.error(json?.error ?? 'Could not connect')
        // A failure part-way through (the first import runs inside this
        // request) can still have created the account - show what now exists
        // rather than leaving a hidden row behind an error toast.
        await reload()
        return
      }
      setToken('')
      toast.success(
        json.sync?.ok
          ? `${json.account.name} connected - ${json.sync.rows} sales imported`
          : `${json.account.name} connected, but the first import failed. See its status below.`,
      )
      await reload()
    } catch {
      toast.error('Could not reach the server')
      // Same reason as above: the server may have finished the create before
      // the connection dropped.
      await reload().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/affiliate/sync', { method: 'POST' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Sync failed')
        return
      }
      // The route answers 200 with per-brand results; a brand whose token died
      // is in there as ok: false, and a green toast over it would contradict
      // the status cell the reload is about to paint red.
      const results = ((await res.json().catch(() => null))?.results ?? []) as {
        name: string
        ok: boolean
      }[]
      const failed = results.filter((r) => !r.ok).map((r) => r.name)
      if (failed.length > 0) {
        toast.error(`Sync failed for ${failed.join(' and ')} - see the status below.`)
      } else {
        toast.success('Affiliate sales refreshed')
      }
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  async function setActive(account: PublicAffiliateAccount) {
    setWorking(account.id)
    try {
      const res = await fetch(`/api/affiliate/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !account.active }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not update the account')
        return
      }
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setWorking(null)
    }
  }

  async function remove(account: PublicAffiliateAccount) {
    // Removing cascades the imported sales away, so the cost they carried
    // vanishes from every past figure too. Say that, and name the alternative.
    if (
      !window.confirm(
        `Remove ${account.name}? Its ${account.transactions.toLocaleString('en-US')} imported sales are deleted with it, so their cost disappears from every figure - this month's and last year's. To stop syncing but keep the history, pause it instead.`,
      )
    )
      return
    setWorking(account.id)
    try {
      const res = await fetch(`/api/affiliate/accounts/${account.id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not remove the account')
        return
      }
      toast.success(`${account.name} removed`)
      await reload()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setWorking(null)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Affiliate"
        subtitle="Addrevenue commissions, imported as a cost per shop and channel. One token per brand; everything else syncs itself a few times a day."
      >
        {accounts.length > 0 && (
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            title="Everything arrives by itself; this just asks Addrevenue right now."
            className={quietBtn}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </PageHeader>

      <PageBody>
        <section className="rounded-[var(--radius-card)] border border-line bg-surface px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">Connect a brand</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            Paste the brand’s API token from Addrevenue (Settings → API). It is checked against
            Addrevenue before anything is stored, then kept encrypted and never shown again. Each
            brand has its own token, so connect them one at a time.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="API token"
              aria-label="API token"
              className="w-80 rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={add}
              disabled={busy || token.trim().length < 10}
              className={primaryBtn}
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </section>

        {accounts.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-panel text-left text-muted">
                    <th className="px-3 py-2.5 font-medium">Brand</th>
                    <th className="px-3 py-2.5 text-right font-medium">Sales imported</th>
                    <th className="px-3 py-2.5 font-medium">Last sync</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="text-ink">
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="px-3 py-2.5 font-medium text-ink">
                        {a.name}
                        <span className="block text-[11px] font-normal text-faint">
                          Advertiser {a.externalId}
                        </span>
                      </td>
                      <td className="num px-3 py-2.5 text-right">
                        {a.transactions.toLocaleString('en-US')}
                      </td>
                      <td className="px-3 py-2.5 text-muted">{when(a.lastSyncAt)}</td>
                      <td className="max-w-sm px-3 py-2.5">
                        <Status account={a} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={() => void setActive(a)}
                            disabled={working !== null}
                            className="font-semibold text-accent hover:underline disabled:opacity-60"
                          >
                            {a.active ? 'Pause' : 'Resume'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(a)}
                            disabled={working !== null}
                            className="font-semibold text-loss hover:underline disabled:opacity-60"
                          >
                            {working === a.id ? 'Working…' : 'Remove'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageBody>
    </AppShell>
  )
}

/**
 * The one cell worth reading twice.
 *
 * A failing sync says so in Addrevenue's own words, in full - a "Error" pill
 * with the reason hidden in a tooltip is how a dead token goes unnoticed for
 * weeks while the affiliate cost quietly stops moving. Sales matching no shop
 * are the other silent failure: they are real money that lands in no per-shop
 * figure, and the fix is a shop's URL, so the cell names both.
 */
function Status({ account }: { account: PublicAffiliateAccount }) {
  if (account.lastError) {
    return (
      <span className="block text-loss">
        <span className="font-semibold">Sync failed.</span> {account.lastError}
      </span>
    )
  }
  if (!account.active) {
    return (
      <span className="block text-muted">
        Paused - nothing is fetched. The sales already imported still count.
      </span>
    )
  }
  if (account.unmatched > 0) {
    return (
      <span className="block text-muted">
        <span className="font-semibold text-ink">OK.</span> {account.unmatched}{' '}
        {account.unmatched === 1 ? 'sale matches' : 'sales match'} no shop, so their cost is
        missing from every per-shop figure - check the shops’ web addresses under Setup → Shops
        against the markets in Addrevenue.
      </span>
    )
  }
  if (!account.lastSyncAt) return <span className="block text-muted">Never synced</span>
  return <span className="block text-gain">OK</span>
}
