'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { useToast } from '@/components/toast/useToast'

type StaffUser = { id: string; email: string; role: 'ADMIN' | 'MARKETING' }

const ROLE_LABEL: Record<StaffUser['role'], string> = { ADMIN: 'Admin', MARKETING: 'Marketing' }

const field = 'mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm'
const label = 'mt-3 block text-xs font-medium text-muted'

/**
 * Admin and Marketing logins. Admins see everything; Marketing sees the
 * ambassador program and nothing else. Ambassador logins are not here -
 * they are minted by invites and belong to their ambassador.
 */
export function UsersClient({ email, myUserId }: { email: string; myUserId: string }) {
  const toast = useToast()
  const [users, setUsers] = useState<StaffUser[]>([])
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<StaffUser['role']>('MARKETING')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/users')
      if (res.ok) setUsers(((await res.json()) as { users: StaffUser[] }).users)
    } catch {
      // The table simply stays as it was.
    }
  }

  useEffect(() => {
    let live = true
    fetch('/api/users')
      .then(async (r) => (r.ok ? ((await r.json()) as { users: StaffUser[] }).users : []))
      .then((data) => {
        if (live) setUsers(data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, role: newRole, password: newPassword }),
      })
      if (!res.ok) {
        toast.error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Could not create the login')
        return
      }
      toast.success(`Login created. Hand ${newEmail} the starter password; they can change it under Your account.`)
      setNewEmail('')
      setNewPassword('')
      await load()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  async function remove(user: StaffUser) {
    if (!window.confirm(`Remove the login for ${user.email}?`)) return
    setRemoving(user.id)
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Could not remove the login')
        return
      }
      toast.success(`${user.email} removed`)
      await load()
    } catch {
      toast.error('Could not reach the server')
    } finally {
      setRemoving(null)
    }
  }

  return (
    <AppShell email={email}>
      <PageHeader
        title="Users"
        subtitle="Admin sees everything. Marketing sees ambassador statistics and the roster, nothing else."
      />
      <PageBody>
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-panel text-left text-muted">
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Role</th>
                  <th className="px-3 py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="text-ink">
                {users.length === 0 && (
                  <tr className="border-t border-line">
                    <td colSpan={3} className="px-3 py-8 text-center text-muted">
                      No staff logins yet.
                    </td>
                  </tr>
                )}
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-line">
                    <td className="px-3 py-2.5 font-medium">{u.email}</td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] font-semibold text-muted">
                        {ROLE_LABEL[u.role]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {u.id !== myUserId && (
                        <button
                          onClick={() => void remove(u)}
                          disabled={removing !== null}
                          className="font-semibold text-loss hover:underline disabled:opacity-60"
                        >
                          {removing === u.id ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form onSubmit={create} className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <h2 className="text-[13px] font-semibold text-ink">Add a login</h2>
            <p className="mt-1 text-[11px] text-muted">
              Hand over the starter password; they change it themselves under Your account. Removing
              a login stops new sign-ins at once; a session already open ends by itself within 7 days.
            </p>

            <label className={label} htmlFor="new-user-email">Email</label>
            <input
              id="new-user-email"
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className={field}
            />

            <label className={label} htmlFor="new-user-role">Role</label>
            <select
              id="new-user-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as StaffUser['role'])}
              className={field}
            >
              <option value="MARKETING">Marketing - ambassadors only</option>
              <option value="ADMIN">Admin - everything</option>
            </select>

            <label className={label} htmlFor="new-user-password">Starter password</label>
            <input
              id="new-user-password"
              type="text"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="at least 8 characters"
              className={field}
            />

            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Creating…' : 'Create login'}
              </button>
            </div>
          </form>
        </div>
      </PageBody>
    </AppShell>
  )
}
