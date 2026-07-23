'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PasswordField } from './PasswordField'

/**
 * One sign-in form, two front doors.
 *
 * Ambassadors are the many, so they get the default door at /login. Staff go to /admin.
 * Both check the same credentials and land you where your role belongs, so using the
 * "wrong" door is never a dead end.
 */
export function SignInForm({ mode }: { mode: 'ambassador' | 'admin' }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isAdmin = mode === 'admin'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Tell the API which door this is, so it can land you on the side you chose.
      body: JSON.stringify({ email, password, mode }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Could not sign in.')
      setBusy(false)
      return
    }

    router.push(data.redirectTo)
    router.refresh()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-[12px] font-bold text-white">
            p
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">panetti-analytics</span>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">
            {isAdmin ? 'Admin sign in' : 'Ambassador sign in'}
          </h1>
          <p className="mt-1 text-[13px] text-muted">
            {isAdmin
              ? 'For the team. See every shop, cost and profit figure.'
              : 'See how much you have sold and what you have earned.'}
          </p>

          <form onSubmit={submit} className="mt-5 space-y-3.5">
            <div>
              <label htmlFor="email" className="block text-[12px] font-medium text-ink">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
                className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-faint"
              />
            </div>

            <PasswordField
              id="password"
              label="Password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
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
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[12px] text-muted">
          {isAdmin ? (
            <>
              Are you an ambassador?{' '}
              <Link href="/login" className="font-medium text-accent hover:underline">
                Sign in here
              </Link>
            </>
          ) : (
            <>
              Part of the team?{' '}
              <Link href="/admin" className="font-medium text-accent hover:underline">
                Admin sign in
              </Link>
            </>
          )}
        </p>
      </div>
    </main>
  )
}
