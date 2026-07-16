'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'

type Code = { id: string; code: string }

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

function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-control)] border border-line bg-warn-soft px-4 py-3 text-xs text-warn"
    >
      {message}
    </div>
  )
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
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPercent, setNewPercent] = useState('10')
  const [newCode, setNewCode] = useState('')

  const busy = pending !== null

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ambassadors')
      if (!res.ok) {
        setError(await errorFrom(res, 'Could not load ambassadors'))
        return
      }
      const data = (await res.json()) as { ambassadors?: Row[] }
      setRows(data.ambassadors ?? [])
    } catch {
      setError('Could not reach the server')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The single door every write goes through, so `res.ok` can never be forgotten and
   * a button can never stick on "Saving…".
   */
  const send: Send = async (key, url, method, body) => {
    setPending(key)
    setError(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(await errorFrom(res, 'That did not work'))
        return false
      }
      await load()
      return true
    } catch {
      setError('Could not reach the server')
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
      code: newCode.trim(),
    })
    if (!ok) return

    setNewName('')
    setNewEmail('')
    setNewPercent('10')
    setNewCode('')
  }

  async function copyInvite(row: Row) {
    if (!row.invitePath) return

    // Built here, not on the server: whatever host the admin is on is the host the
    // ambassador must land on. Nothing to configure, nothing to get wrong.
    const link = `${window.location.origin}${row.invitePath}`
    setError(null)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(row.id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // No clipboard (old browser, insecure origin) — show the link rather than lose it.
      setError(`Could not reach the clipboard. The invite link is ${link}`)
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
        {/* While the modal is open it carries the error — this one would sit behind it. */}
        {!editing && error && (
          <div className="mb-4">
            <ErrorNote message={error} />
          </div>
        )}

        <form
          data-testid="add-ambassador"
          onSubmit={add}
          className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
        >
          <h2 className="text-[13px] font-semibold text-ink">Add an ambassador</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            They set their own password from the invite link. Their discount code is what earns
            them commission.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_7rem_1fr_auto]">
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
            {/* Codes are stored uppercase, so type them that way. */}
            <input
              aria-label="Discount code"
              placeholder="Discount code"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className={`${INPUT} uppercase placeholder:normal-case`}
            />
            <button
              type="submit"
              disabled={busy || !newName.trim() || !newEmail.trim() || !newCode.trim()}
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
                <th className="px-3 py-2.5" />
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
                          </span>
                        ))}
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
          error={error}
          pending={pending}
          send={send}
          onClose={() => {
            setEditingId(null)
            setError(null)
          }}
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
  error,
  pending,
  send,
  onClose,
}: {
  row: Row
  error: string | null
  pending: string | null
  send: Send
  onClose: () => void
}) {
  const [percent, setPercent] = useState(String(row.commissionPercent))
  const [code, setCode] = useState('')
  const busy = pending !== null

  async function saveCommission() {
    const ok = await send('commission', `/api/ambassadors/${row.id}`, 'PATCH', {
      commissionPercent: Number(percent),
    })
    if (ok) onClose()
  }

  async function addCode() {
    if (await send('add-code', `/api/ambassadors/${row.id}/codes`, 'POST', { code: code.trim() })) {
      setCode('')
    }
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
              <span className="text-sm font-semibold text-ink">{c.code}</span>
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

        <div className="mt-2 flex gap-2">
          <input
            aria-label="New discount code"
            placeholder="Another code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${INPUT} w-full uppercase placeholder:normal-case`}
          />
          <button
            onClick={addCode}
            disabled={busy || !code.trim()}
            className="shrink-0 rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-panel disabled:opacity-60"
          >
            {pending === 'add-code' ? 'Adding…' : 'Add code'}
          </button>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorNote message={error} />
          </div>
        )}

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
