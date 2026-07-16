'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordField } from '@/components/PasswordField'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/account-rules'

/**
 * Where an ambassador chooses their password and is signed in by doing so.
 *
 * The name is here to prove the link is theirs before they type a secret into it. The two
 * checks below are the API's own rules answered faster — the API applies them regardless,
 * and its refusals are written to be read, so they are shown as they come.
 */
export function InviteClient({ token, name }: { token: string; name: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    // Spaces at either end are not characters anyone can rely on remembering.
    if (password.trim().length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })

      // A proxy or a crash might not answer JSON at all, hence the fallback.
      const data = (await res.json().catch(() => null)) as {
        error?: string
        redirectTo?: string
      } | null

      if (!res.ok) {
        setError(data?.error ?? 'Could not set your password.')
        return
      }

      // Already signed in — the API set the session cookie on this very response.
      router.push(data?.redirectTo ?? '/portal')
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-[12px] font-bold text-white">
            e
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">ecom-analytics</span>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">Welcome, {name}</h1>
          <p className="mt-1 text-[13px] text-muted">
            Choose a password and your portal is ready. You will use it to sign in from now on.
          </p>

          <form data-testid="invite-form" onSubmit={submit} className="mt-5 space-y-3.5">
            <PasswordField
              id="password"
              label="Password"
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              required
            />

            <PasswordField
              id="confirm-password"
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              required
            />

            {error && (
              <p
                role="alert"
                className="rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[12px] text-loss"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-[var(--radius-control)] bg-ink py-2.5 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Setting up…' : 'Set password'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}
