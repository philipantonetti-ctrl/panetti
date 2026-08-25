'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/toast/useToast'

type ShopOption = { id: string; name: string }

type Campaign = { id: string; externalId: string; name: string; shopId: string | null }

type CampaignsPayload = {
  splitByCampaign: boolean
  defaultShopId: string
  campaigns: Campaign[]
}

/**
 * Which store each campaign on an ad account advertises for. Sits beside
 * PickerModal in this file's neighbourhood: same "list things from a
 * platform, assign each to a shop" shape, so it borrows PickerModal's shell,
 * spacing and button classes rather than inventing a second look. It also
 * splits its errors the way PickerModal does: the load failure stays as
 * inline `error` state (the modal has nothing worth showing until it loads),
 * while the save result goes through `toast`, like AccountModal - an admin
 * re-attributing a campaign's spend history needs the same confirmation its
 * sibling modals give on Save.
 *
 * '' is the select's "unassigned" value, not a shop id - the account's own
 * shop is the fallback, and the API spells that fallback as `shopId: null`.
 * Mapping happens at the edges: null -> '' on load, '' -> null on save.
 */
export function CampaignsModal({
  accountId,
  shops,
  onClose,
  onSaved,
}: {
  accountId: string
  shops: ShopOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [splitByCampaign, setSplitByCampaign] = useState(false)
  const [rows, setRows] = useState<(Campaign & { shopId: string })[]>([])
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`/api/ad-accounts/${accountId}/campaigns`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not load campaigns')
        return res.json()
      })
      .then((json: CampaignsPayload) => {
        setSplitByCampaign(json.splitByCampaign)
        setRows(json.campaigns.map((c) => ({ ...c, shopId: c.shopId ?? '' })))
        setError('')
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [accountId])

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/ad-accounts/${accountId}/campaigns`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          splitByCampaign,
          assignments: rows.map((r) => ({
            campaignId: r.id,
            shopId: r.shopId === '' ? null : r.shopId,
          })),
        }),
      })
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? 'Could not save the campaigns')
        return
      }
      toast.success('Campaigns updated')
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
        <h2 className="text-base font-bold text-ink">Campaigns</h2>
        <p className="mt-1 text-xs text-muted">
          Say which store each campaign advertises for. A campaign left on “Use the account&apos;s
          store” follows the account&apos;s own shop.
        </p>

        <label className="mt-4 flex items-center gap-2 text-xs font-medium text-ink">
          <input
            type="checkbox"
            checked={splitByCampaign}
            onChange={(e) => setSplitByCampaign(e.target.checked)}
            className="h-4 w-4"
          />
          Split this account by campaign
        </label>

        {loading && <p className="mt-4 text-sm text-muted">Asking the platform…</p>}
        {error && <p className="mt-4 text-sm text-loss">{error}</p>}

        {!loading && !error && (
          <div className="mt-4 space-y-2">
            {rows.length === 0 && (
              <p className="text-sm text-muted">No campaigns yet. Press Sync now, then come back.</p>
            )}
            {rows.map((row, i) => (
              <div
                key={row.id}
                className="flex items-center gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{row.name}</p>
                </div>
                <select
                  value={row.shopId}
                  aria-label={`Store for ${row.name}`}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r, j) => (j === i ? { ...r, shopId: e.target.value } : r)),
                    )
                  }
                  className="rounded-[var(--radius-control)] border border-line px-2 py-1.5 text-xs"
                >
                  <option value="">Use the account&apos;s store</option>
                  {shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
            Close
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || loading}
            className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
