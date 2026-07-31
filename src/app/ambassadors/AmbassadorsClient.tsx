'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { CodeCombobox } from '@/components/CodeCombobox'
import { Leaderboard } from '@/components/dashboard/Leaderboard'
import { useToast } from '@/components/toast/useToast'
import { PRESET_LABELS, type Preset } from '@/lib/dates'
import type { LeaderboardRow } from '@/lib/metrics/ambassadors'
import { ProductOverview, type ProductSummaryRow } from '@/components/ambassadors/ProductOverview'
import { ProductLedger, type CatalogueItem, type Gift } from '@/components/ambassadors/ProductLedger'
import { forShop, today } from '@/components/ambassadors/GiftFields'
import { ProductTickList } from '@/components/ambassadors/ProductTickList'

type Code = { id: string; code: string; shopId: string; shopName: string }
type Shop = { id: string; name: string }


type Row = {
  id: string
  name: string
  email: string
  /** A PERCENT: 10 means 10%. The column holds a fraction; the API converts. */
  commissionPercent: number
  active: boolean
  codes: Code[]
  /** What we sent them, newest first. */
  products: Gift[]
  onboarded: boolean
  /** The email already belongs to a login (typically the owner's admin account). */
  emailHasLogin: boolean
  /** A path, so the link is built against whatever host the admin is on. Null when no invite can be redeemed. */
  invitePath: string | null
}

/**
 * The discount codes defined in one store, for the picker. Fetched only when a
 * store is chosen, so visiting the page never calls every store at once. A
 * store that is unconnected or offline simply returns nothing, and the field
 * falls back to typing.
 */
function useShopCoupons(shopId: string) {
  const [codes, setCodes] = useState<string[]>([])
  // Which store `codes` reflects. Deriving "loading" from this (rather than a
  // synchronous setState in the effect) keeps the effect lint-clean.
  const [loadedFor, setLoadedFor] = useState('')

  useEffect(() => {
    if (!shopId) return
    let alive = true
    fetch(`/api/coupons?shopId=${encodeURIComponent(shopId)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { codes: string[] }).codes : []))
      .then((cs) => {
        if (alive) {
          setCodes(cs)
          setLoadedFor(shopId)
        }
      })
      .catch(() => {
        if (alive) {
          setCodes([])
          setLoadedFor(shopId)
        }
      })
    return () => {
      alive = false
    }
  }, [shopId])

  const ready = loadedFor === shopId
  return { codes: ready ? codes : [], loading: shopId !== '' && !ready }
}

/** Every write goes through one of these, keyed so only the button you pressed says "Saving…". */
type Send = (key: string, url: string, method: string, body: unknown) => Promise<boolean>

const INPUT =
  'rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint'

/**
 * The API answers `{ error }` and those messages are written to be read — so show them.
 * A proxy or a crash might not answer JSON at all, hence the fallback.
 */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error ?? fallback
}

/** A percent field that says so — 10 means 10%, never 0.1. */
function PercentField({
  id,
  ariaLabel,
  value,
  onChange,
  disabled,
}: {
  id?: string
  ariaLabel: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center rounded-[var(--radius-control)] border border-line bg-surface pr-3">
      <input
        id={id}
        aria-label={ariaLabel}
        type="number"
        min="0"
        max="100"
        step="0.1"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent px-3 py-2 text-sm text-ink outline-none"
      />
      <span className="text-xs font-medium text-muted">%</span>
    </div>
  )
}

function StatusPill({ row }: { row: Row }) {
  // Deactivated first: an onboarded ambassador who is switched off is not "Active".
  if (!row.active) {
    return (
      <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-semibold text-warn">
        Deactivated
      </span>
    )
  }
  if (row.onboarded) {
    return (
      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-gain">
        Active
      </span>
    )
  }
  // Their email is already a login (usually the owner, who is admin too), so
  // there is no invite to send — they sign in with the account they have.
  if (row.emailHasLogin) {
    return (
      <span
        title="This email already has a login. They sign in with it; their ambassador sales show on the dashboard."
        className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-gain"
      >
        Uses existing login
      </span>
    )
  }
  return (
    <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
      Not set up yet
    </span>
  )
}

/** The period choices for the statistics — the everyday ones, nothing exotic. */
const STAT_PRESETS: Preset[] = ['this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_year']

type Stats = {
  leaderboard: LeaderboardRow[]
  shopOptions: { id: string; name: string }[]
  displayCurrency: string
}

export function AmbassadorsClient({
  email,
  role = 'ADMIN',
}: {
  email: string
  role?: 'ADMIN' | 'MARKETING'
}) {
  const toast = useToast()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // The overview card and the modal's picker come from one request, because
  // they are one screen.
  const [overview, setOverview] = useState<ProductSummaryRow[]>([])
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])

  const [shops, setShops] = useState<Shop[]>([])
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPercent, setNewPercent] = useState('10')
  const [newShopId, setNewShopId] = useState('')
  const [newCode, setNewCode] = useState('')
  const { codes: newCodes, loading: newCodesLoading } = useShopCoupons(newShopId)

  // What we are sending the new ambassador. Held here, not written yet: there is
  // no ambassador to attach a gift to until the form is submitted, so these ride
  // along with the create as one request.
  const [newSkus, setNewSkus] = useState<string[]>([])
  const [newReceivedAt, setNewReceivedAt] = useState(today())
  const [newNote, setNewNote] = useState('')

  // The statistics above the roster: who sold, filtered by shop and period.
  const [stats, setStats] = useState<Stats | null>(null)
  const [statShop, setStatShop] = useState('') // '' = all shops
  const [statPreset, setStatPreset] = useState<Preset>('this_month')
  useEffect(() => {
    let live = true
    const params = new URLSearchParams({ preset: statPreset })
    if (statShop) params.set('shops', statShop)
    fetch(`/api/ambassadors/stats?${params}`)
      .then(async (r) => (r.ok ? ((await r.json()) as Stats) : null))
      .then((data) => {
        if (live && data) setStats(data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [statShop, statPreset])

  const busy = pending !== null

  // The stores for the code picker. A failure just leaves the select empty; the
  // field still lets you type a code.
  useEffect(() => {
    let live = true
    fetch('/api/shops')
      .then(async (r) => (r.ok ? ((await r.json()) as { shops?: Shop[] }).shops ?? [] : []))
      .then((data) => {
        if (live) setShops(data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ambassadors')
      if (!res.ok) {
        toast.error(await errorFrom(res, 'Could not load ambassadors'))
        return
      }
      const data = (await res.json()) as { ambassadors?: Row[] }
      setRows(data.ambassadors ?? [])
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setLoading(false)
    }
  }, [toast])

  /** Refreshed alongside the roster: adding a product changes both. */
  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/ambassador-products')
      if (!res.ok) return // the card simply stays as it was
      const data = (await res.json()) as {
        overview?: ProductSummaryRow[]
        catalogue?: CatalogueItem[]
      }
      setOverview(data.overview ?? [])
      setCatalogue(data.catalogue ?? [])
    } catch {
      // Offline. The roster's own error toast has already said so.
    }
  }, [])

  // Initial load, inlined for the same reason as the roster's own initial-load
  // effect below: calling the `loadProducts` callback directly from an effect
  // body reads as a synchronous setState path to the lint rule, even though the
  // sets only happen after the fetch resolves. `loadProducts` itself stays
  // available for `send()` to call after a write.
  useEffect(() => {
    let live = true
    fetch('/api/ambassador-products')
      .then(async (r) =>
        r.ok
          ? ((await r.json()) as { overview?: ProductSummaryRow[]; catalogue?: CatalogueItem[] })
          : null,
      )
      .then((data) => {
        if (live && data) {
          setOverview(data.overview ?? [])
          setCatalogue(data.catalogue ?? [])
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Initial load, inlined so setState stays inside async callbacks (the lint
  // rule forbids a synchronous setState path out of an effect). Writes reuse the
  // richer `load` above, which also surfaces errors as toasts.
  useEffect(() => {
    let live = true
    fetch('/api/ambassadors')
      .then(async (r) => (r.ok ? ((await r.json()) as { ambassadors?: Row[] }).ambassadors ?? [] : []))
      .then((data) => {
        if (live) {
          setRows(data)
          setLoading(false)
        }
      })
      .catch(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [])

  /**
   * The single door every write goes through, so `res.ok` can never be forgotten and
   * a button can never stick on "Saving…".
   */
  const send: Send = async (key, url, method, body) => {
    setPending(key)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        toast.error(await errorFrom(res, 'That did not work'))
        return false
      }
      // Both, because adding a product changes the roster chips AND the counts.
      await Promise.all([load(), loadProducts()])
      return true
    } catch {
      toast.error('Could not reach the server')
      return false
    } finally {
      setPending(null)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    const ok = await send('add', '/api/ambassadors', 'POST', {
      name: newName.trim(),
      email: newEmail.trim(),
      commissionPercent: Number(newPercent),
      shopId: newShopId,
      code: newCode.trim(),
      products: newSkus.map((sku) => ({
        sku,
        // The NAME travels with the SKU: the record is a snapshot, so renaming
        // a shop's listing later never rewrites what we handed over.
        name: catalogue.find((c) => c.sku === sku)?.name ?? sku,
        receivedAt: newReceivedAt,
        note: newNote.trim() || undefined,
      })),
    })
    if (!ok) return

    setNewName('')
    setNewEmail('')
    setNewPercent('10')
    setNewShopId('')
    setNewCode('')
    setNewSkus([])
    setNewReceivedAt(today())
    setNewNote('')
  }

  /**
   * Delete is for mistakes and test entries only. It takes their codes and login with
   * it and cannot be undone, so ask first — and the server refuses outright for anyone
   * who has actually sold, whose history must survive them. That refusal is worth
   * reading, so it goes through `send` like every other write.
   */
  async function remove(row: Row) {
    if (!window.confirm(`Delete ${row.name}? This cannot be undone.`)) return
    const ok = await send(`delete-${row.id}`, `/api/ambassadors/${row.id}`, 'DELETE', {})

    // A destructive act deserves confirmation; send() already toasts a refusal,
    // and the toast is visible regardless of scroll position.
    if (ok) toast.success(`${row.name} deleted`)
  }

  async function copyInvite(row: Row) {
    if (!row.invitePath) return

    // Built here, not on the server: whatever host the admin is on is the host the
    // ambassador must land on. Nothing to configure, nothing to get wrong.
    const link = `${window.location.origin}${row.invitePath}`
    try {
      await navigator.clipboard.writeText(link)
      // The button label itself flips to "Copied" for 2s — that confirmation is
      // already co-located with the click. A toast here would only repeat it.
      setCopied(row.id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // No clipboard (old browser, insecure origin) — show the link rather than lose it.
      toast.error(`Could not reach the clipboard. The invite link is ${link}`)
    }
  }

  const editing = rows.find((r) => r.id === editingId) ?? null

  return (
    <AppShell email={email} role={role}>
      <PageHeader
        title="Ambassadors"
        subtitle="Who sold what, and the roster: add an ambassador, send their invite link, set what they earn."
      >
        <select
          aria-label="Shops"
          value={statShop}
          onChange={(e) => setStatShop(e.target.value)}
          className={INPUT}
        >
          <option value="">All shops</option>
          {(stats?.shopOptions ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Period"
          value={statPreset}
          onChange={(e) => setStatPreset(e.target.value as Preset)}
          className={INPUT}
        >
          {STAT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </select>
      </PageHeader>

      <PageBody>
        {stats && (
          <div className="mb-4">
            <Leaderboard rows={stats.leaderboard} currency={stats.displayCurrency} />
          </div>
        )}
        <form
          data-testid="add-ambassador"
          onSubmit={add}
          className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
        >
          <h2 className="text-[13px] font-semibold text-ink">Add an ambassador</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            They set their own password from the invite link. Pick the store their code lives on,
            then choose or type the code. The same code can exist on other stores meaning a
            different person, so each is tracked separately.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_5.5rem_11rem_1fr_auto]">
            <input
              aria-label="Name"
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className={INPUT}
            />
            <input
              aria-label="Email"
              type="email"
              placeholder="Email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className={INPUT}
            />
            <PercentField
              ariaLabel="Commission percent"
              value={newPercent}
              onChange={setNewPercent}
              disabled={busy}
            />
            <select
              aria-label="Store"
              value={newShopId}
              onChange={(e) => {
                setNewShopId(e.target.value)
                setNewCode('')
                // Ticks belong to the store that offered them. Carrying a
                // Norwegian selection into Sweden would attach products that
                // store does not sell.
                setNewSkus([])
              }}
              className={INPUT}
            >
              <option value="">Store</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {/* Codes are stored uppercase; the combobox uppercases as you type. */}
            <CodeCombobox
              value={newCode}
              onChange={setNewCode}
              codes={newCodes}
              loading={newCodesLoading}
              disabled={!newShopId}
              className={INPUT}
            />
            <button
              type="submit"
              // A product is required, so the button is the place that says so.
              disabled={
                busy ||
                !newName.trim() ||
                !newEmail.trim() ||
                !newShopId ||
                !newCode.trim() ||
                newSkus.length === 0
              }
              className="whitespace-nowrap rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {pending === 'add' ? 'Saving…' : 'Add ambassador'}
            </button>
          </div>

          <ProductTickList
            catalogue={forShop(catalogue, newShopId ? [newShopId] : [])}
            storeName={shops.find((s) => s.id === newShopId)?.name ?? null}
            selected={newSkus}
            onToggle={(sku) =>
              setNewSkus((list) =>
                list.includes(sku) ? list.filter((s) => s !== sku) : [...list, sku],
              )
            }
            receivedAt={newReceivedAt}
            onReceivedAt={setNewReceivedAt}
            note={newNote}
            onNote={setNewNote}
            disabled={busy}
          />
        </form>

        <ProductOverview rows={overview} />

        <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-panel text-left text-muted">
                <th className="px-3 py-2.5 font-medium">Ambassador</th>
                <th className="px-3 py-2.5 font-medium">Commission</th>
                <th className="px-3 py-2.5 font-medium">Codes</th>
                <th className="px-3 py-2.5 font-medium">Products</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-faint">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-faint">
                    No ambassadors yet. Add the first one above.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} data-testid="ambassador-row" className="border-t border-line">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink">{row.name}</div>
                      <div className="text-[11px] text-faint">{row.email}</div>
                    </td>
                    <td className="px-3 py-2.5">{row.commissionPercent}%</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {row.codes.map((c) => (
                          <span
                            key={c.id}
                            className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink"
                          >
                            {c.code}
                            <span className="ml-1 font-normal text-faint">· {c.shopName}</span>
                          </span>
                        ))}
                        {row.codes.length === 0 && <span className="text-[11px] text-faint">—</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {row.products.map((p) => (
                          <span
                            key={p.id}
                            title={`${p.quantity} × ${p.name}, received ${p.receivedAt.slice(0, 10)}${p.note ? ` — ${p.note}` : ''}`}
                            className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink"
                          >
                            {p.name}
                            {/* Only when it is more than one. Every new record
                                is a single product, so a chip of ×1 on all of
                                them is noise — but the rows already carrying 2
                                must not quietly start reading as 1. */}
                            {p.quantity > 1 && (
                              <span className="ml-1 font-normal text-faint">×{p.quantity}</span>
                            )}
                          </span>
                        ))}
                        {row.products.length === 0 && (
                          <span className="text-[11px] text-faint">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill row={row} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        {/* Nobody who already has a login needs an invite. */}
                        {!row.onboarded && row.invitePath && (
                          <button
                            data-testid="copy-invite"
                            onClick={() => copyInvite(row)}
                            className="font-semibold text-accent hover:underline"
                          >
                            {copied === row.id ? 'Copied' : 'Copy invite link'}
                          </button>
                        )}
                        <button
                          onClick={() => setEditingId(row.id)}
                          className="font-semibold text-accent hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() =>
                            void send(`active-${row.id}`, `/api/ambassadors/${row.id}`, 'PATCH', {
                              active: !row.active,
                            })
                          }
                          disabled={busy}
                          className="font-semibold text-muted transition-colors duration-150 hover:text-ink hover:underline disabled:opacity-60"
                        >
                          {row.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                        {/* Never disabled for someone who has sold: the server's reason is worth reading. */}
                        <button
                          onClick={() => void remove(row)}
                          disabled={busy}
                          className="font-semibold text-loss hover:underline disabled:opacity-60"
                        >
                          {pending === `delete-${row.id}` ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </PageBody>

      {editing && (
        <EditModal
          key={editing.id}
          row={editing}
          shops={shops}
          catalogue={catalogue}
          pending={pending}
          send={send}
          onClose={() => setEditingId(null)}
        />
      )}
    </AppShell>
  )
}

/**
 * Commission is a value you save; codes act the moment you press them, because each
 * one is its own request the server can refuse for its own reason.
 */
function EditModal({
  row,
  shops,
  catalogue,
  pending,
  send,
  onClose,
}: {
  row: Row
  shops: Shop[]
  catalogue: CatalogueItem[]
  pending: string | null
  send: Send
  onClose: () => void
}) {
  const [percent, setPercent] = useState(String(row.commissionPercent))
  const [codeShopId, setCodeShopId] = useState('')
  const [code, setCode] = useState('')
  const { codes: shopCodes, loading: codesLoading } = useShopCoupons(codeShopId)
  const busy = pending !== null

  async function saveCommission() {
    const ok = await send('commission', `/api/ambassadors/${row.id}`, 'PATCH', {
      commissionPercent: Number(percent),
    })
    if (ok) onClose()
  }

  async function addCode() {
    const ok = await send('add-code', `/api/ambassadors/${row.id}/codes`, 'POST', {
      code: code.trim(),
      shopId: codeShopId,
    })
    if (ok) setCode('')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
    >
      {/* The panel is a flex column so the title and the buttons stay put and
          only the middle scrolls. A ledger grows without limit; Save must not
          drift below the fold with it. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-ambassador-name"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-line px-5 py-4">
          <h2 id="edit-ambassador-name" className="text-base font-bold text-ink">
            {row.name}
          </h2>
          <p className="mt-0.5 text-xs text-muted">{row.email}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <label htmlFor="commission" className="block text-[13px] font-semibold text-ink">
          Commission
        </label>
        <div className="mt-2">
          <PercentField
            id="commission"
            ariaLabel="Commission percent"
            value={percent}
            onChange={setPercent}
            disabled={busy}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          Paid on every order placed with one of their codes.
        </p>

        {/* Sections are separated by a hairline and named in ink, so a heading
            never reads as just another field label. */}
        <h3 className="mt-4 border-t border-line pt-4 text-[13px] font-semibold text-ink">
          Discount codes
        </h3>
        <div className="mt-2 space-y-1">
          {row.codes.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-[var(--radius-control)] border border-line px-3 py-1.5"
            >
              <span className="text-sm font-semibold text-ink">
                {c.code}
                <span className="ml-1.5 text-xs font-normal text-faint">· {c.shopName}</span>
              </span>
              {/* Never disabled on the last code: the server's reason is worth reading. */}
              <button
                onClick={() =>
                  void send(`remove-${c.id}`, `/api/ambassadors/${row.id}/codes`, 'DELETE', {
                    codeId: c.id,
                  })
                }
                disabled={busy}
                aria-label={`Remove code ${c.code}`}
                className="text-xs font-semibold text-loss hover:underline disabled:opacity-60"
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] font-medium text-muted">Add a code on a store</p>
        {/* minmax(0,1fr), never a bare 1fr: a grid track's automatic minimum is
            its content's min-width, and the combobox input's is wide enough to
            push this row past the modal, clip "Add code" off the right edge and
            raise a horizontal scrollbar. */}
        <div className="mt-1 grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
          <select
            aria-label="Code store"
            value={codeShopId}
            onChange={(e) => {
              setCodeShopId(e.target.value)
              setCode('')
            }}
            className={INPUT}
          >
            <option value="">Store</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <CodeCombobox
            value={code}
            onChange={setCode}
            codes={shopCodes}
            loading={codesLoading}
            disabled={!codeShopId}
            ariaLabel="New discount code"
            placeholder="Another code"
            className={INPUT}
          />
          <button
            onClick={addCode}
            disabled={busy || !codeShopId || !code.trim()}
            className="shrink-0 rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
          >
            {pending === 'add-code' ? 'Adding…' : 'Add code'}
          </button>
        </div>

        <ProductLedger
          ambassadorId={row.id}
          gifts={row.products}
          // The same rule the Add form follows, applied where the store is
          // already known rather than chosen: only what their own stores sell.
          catalogue={forShop(catalogue, row.codes.map((c) => c.shopId))}
          storeNames={[...new Set(row.codes.map((c) => c.shopName))]}
          pending={pending}
          send={send}
        />
        </div>

        {/* Save covers the commission alone: everything below it is its own
            request that already went through. Saying so here, where the button
            is, is the only place the ambiguity actually arises. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          {/* Dropped on phones, where wrapping it to two lines costs more room
              than the sentence is worth on a screen this admin rarely uses. */}
          <p className="hidden min-w-0 text-[11px] text-faint sm:block">
            Codes and products save as you add them.
          </p>
          {/* ml-auto, not the row's justify-between: with the hint hidden on a
              phone these become the only child and would sit left. */}
          <div className="ml-auto flex shrink-0 gap-2">
            <button onClick={onClose} className="px-3 py-2 text-xs text-muted">
              Cancel
            </button>
            <button
              onClick={saveCommission}
              disabled={busy}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {pending === 'commission' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
