'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Could not sign in')
      setBusy(false)
      return
    }
    router.push(data.redirectTo)
    router.refresh()
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-panel p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-[var(--radius-card)] border border-line bg-surface p-8 shadow-sm">
        <h1 className="text-xl font-bold text-ink">ecom-analytics</h1>
        <p className="mt-1 text-sm text-muted">Sign in to continue</p>

        {/* htmlFor + id matter: they are what makes the label actually LABEL the input,
            for screen readers and for the end-to-end tests that find fields by label. */}
        <label htmlFor="email" className="mt-6 block text-xs font-medium uppercase tracking-wide text-muted">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <label htmlFor="password" className="mt-4 block text-xs font-medium uppercase tracking-wide text-muted">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="mt-1 w-full rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        {error && <p className="mt-4 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-sm text-loss">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-[var(--radius-control)] bg-ink py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
