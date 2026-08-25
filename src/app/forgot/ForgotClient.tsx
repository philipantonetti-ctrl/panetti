'use client'

import Link from 'next/link'
import { useState } from 'react'

/**
 * Where someone who cannot sign in asks for a way back.
 *
 * The confirmation is deliberately conditional - "if that email has a login" -
 * and must stay that way. The route answers identically for a known address, an
 * unknown one and a broken mailer precisely so this form cannot be used to
 * discover which of the ambassadors has an account; wording that said "we have
 * sent you an email" would give away on screen exactly what the route is
 * careful not to say.
 */
export function ForgotClient() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)

    try {
      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      // A proxy or a crash might not answer JSON at all, hence the fallback -
      // the same guard InviteClient uses.
      const data = (await res.json().catch(() => null)) as { error?: string } | null

      if (!res.ok) {
        setError(data?.error ?? 'Could not send the link.')
        return
      }

      setSent(true)
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
            p
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">panetti-analytics</span>
        </div>

        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">Forgot your password</h1>

          {sent ? (
            <p
              role="status"
              className="mt-3 rounded-[var(--radius-control)] bg-accent-soft px-3 py-2.5 text-[13px] text-ink"
            >
              If that email has a login, we have sent you a reset link. It works for one hour.
              Check your spam folder if it does not arrive.
            </p>
          ) : (
            <>
              <p className="mt-1 text-[13px] text-muted">
                Enter your email and we will send you a link to choose a new one.
              </p>

              <form data-testid="forgot-form" onSubmit={submit} className="mt-5 space-y-3.5">
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
                  {busy ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-[12px] text-muted">
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
