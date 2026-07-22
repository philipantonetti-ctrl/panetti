'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { CodeCombobox } from '@/components/CodeCombobox'
import { useToast } from '@/components/toast/useToast'

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
  onboarded: boolean
  /** A path, so the link is built against whatever host the admin is on. Null once onboarded. */
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
  return (
    <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
      Not set up yet
    </span>
  )
}

export function AmbassadorsClient({ email }: { email: string }) {
  const toast = useToast()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [shops, setShops] = useState<Shop[]>([])
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPercent, setNewPercent] = useState('10')
  const [newShopId, setNewShopId] = useState('')
  const [newCode, setNewCode] = useState('')
  const { codes: newCodes, loading: newCodesLoading } = useShopCoupons(newShopId)

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
      await load()
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
    })
    if (!ok) return

    setNewName('')
    setNewEmail('')
    setNewPercent('10')
    setNewShopId('')
    setNewCode('')
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
    <AppShell email={email}>
      <PageHeader
        title="Ambassadors"
        subtitle="Add an ambassador, send them their invite link, and set what they earn."
      />

      <PageBody>
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
              disabled={busy || !newName.trim() || !newEmail.trim() || !newShopId || !newCode.trim()}
              className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-xs font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {pending === 'add' ? 'Saving…' : 'Add ambassador'}
            </button>
          </div>
        </form>

        <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-panel text-left text-muted">
                <th className="px-3 py-2.5 font-medium">Ambassador</th>
                <th className="px-3 py-2.5 font-medium">Commission</th>
                <th className="px-3 py-2.5 font-medium">Codes</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-faint">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-faint">
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
  pending,
  send,
  onClose,
}: {
  row: Row
  shops: Shop[]
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
      <div
        className="w-full max-w-md rounded-[var(--radius-card)] bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-ink">{row.name}</h2>
        <p className="mt-1 text-xs text-muted">{row.email}</p>

        <label htmlFor="commission" className="mt-4 block text-xs font-medium text-muted">
          Commission on every order using their code
        </label>
        <div className="mt-1">
          <PercentField
            id="commission"
            ariaLabel="Commission percent"
            value={percent}
            onChange={setPercent}
            disabled={busy}
          />
        </div>

        <p className="mt-4 text-xs font-medium text-muted">Discount codes</p>
        <div className="mt-1 space-y-1">
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
        <div className="mt-1 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
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

        <div className="mt-5 flex justify-end gap-2">
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
  )
}
