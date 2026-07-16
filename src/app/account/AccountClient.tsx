'use client'

import { useEffect, useState } from 'react'
import { AppShell, PageBody, PageHeader } from '@/components/shell/AppShell'
import { PasswordField } from '@/components/PasswordField'
import { checkNewPassword, checkProfile } from '@/lib/auth/account-rules'
import { useToast } from '@/components/toast/useToast'

type Account = {
  email: string
  role: string
  name: string
  codes: string[]
  commissionRate: number | null
}

/** A saved / failed message that speaks plainly. */
function Notice({ tone, children }: { tone: 'ok' | 'bad'; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={`mt-3 rounded-[var(--radius-control)] px-3 py-2 text-[12px] ${
        tone === 'ok' ? 'bg-panel text-gain' : 'bg-warn-soft text-loss'
      }`}
    >
      {children}
    </p>
  )
}

function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string
  label: string
  hint?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-medium text-ink">
        {label}
      </label>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
      <input
        id={id}
        {...input}
        className="mt-1 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-faint"
      />
    </div>
  )
}

export function AccountClient({ email, isAmbassador }: { email: string; isAmbassador: boolean }) {
  const toast = useToast()
  const [account, setAccount] = useState<Account | null>(null)

  // Basic info
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [savingInfo, setSavingInfo] = useState(false)
  const [infoNote, setInfoNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  // Password
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordNote, setPasswordNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    fetch('/api/account')
      .then((r) => r.json())
      .then((d: Account) => {
        setAccount(d)
        setName(d.name)
        setAddress(d.email)
      })
  }, [])

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault()

    const problem = checkProfile(name, address)
    if (problem) return setInfoNote({ tone: 'bad', text: problem })

    setSavingInfo(true)
    const res = await fetch('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email: address }),
    })
    const data = await res.json()
    setSavingInfo(false)

    // An action result, not form state: the toast reports it and the form is
    // left alone. `infoNote` stays for validation, which must persist while
    // they fix the field.
    if (res.ok) toast.success('Saved.')
    else toast.error(data.error ?? 'Could not save your details.')
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()

    const problem = checkNewPassword(current, next, confirm)
    if (problem) return setPasswordNote({ tone: 'bad', text: problem })

    setSavingPassword(true)
    const res = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      }),
    })
    const data = await res.json()
    setSavingPassword(false)

    if (res.ok) {
      toast.success('Your password has been changed.')
      setCurrent('')
      setNext('')
      setConfirm('')
    } else {
      // "Your current password is wrong" is about a field they must retype, so
      // it stays inline where they are looking.
      setPasswordNote({ tone: 'bad', text: data.error ?? 'Could not change your password.' })
    }
  }

  return (
    <AppShell email={email} nav={!isAmbassador}>
      <PageHeader title="Your account" subtitle="Your details and your password." />

      <PageBody>
        <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
          {/* Basic info */}
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[13px] font-semibold text-ink">Your details</h2>

            <form onSubmit={saveInfo} className="mt-4 space-y-3">
              <Field
                id="name"
                label="Name"
                hint={isAmbassador ? 'This is the name shown on the leaderboard.' : undefined}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
              />

              <Field
                id="email"
                label="Email"
                hint="You sign in with this."
                type="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                autoComplete="email"
              />

              {account && isAmbassador && (
                <div className="rounded-[var(--radius-control)] bg-panel px-3 py-2.5">
                  <p className="text-[11px] font-semibold text-faint">YOUR DISCOUNT CODE</p>
                  <p className="num mt-0.5 text-[14px] font-semibold text-ink">
                    {account.codes.join(', ') || 'Not set yet'}
                  </p>
                  <p className="mt-1 text-[11px] text-muted">
                    {account.commissionRate !== null
                      ? `You earn ${(account.commissionRate * 100).toFixed(0)}% of every net sale placed with it. Ask an admin to change your code.`
                      : 'Ask an admin to set up your code.'}
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={savingInfo}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
              >
                {savingInfo ? 'Saving…' : 'Save details'}
              </button>

              {infoNote && <Notice tone={infoNote.tone}>{infoNote.text}</Notice>}
            </form>
          </section>

          {/* Password */}
          <section className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
            <h2 className="text-[13px] font-semibold text-ink">Change your password</h2>
            <p className="mt-0.5 text-[12px] text-muted">
              You need your current password to set a new one.
            </p>

            <form onSubmit={savePassword} className="mt-4 space-y-3">
              <PasswordField
                id="current-password"
                label="Current password"
                value={current}
                onChange={setCurrent}
                autoComplete="current-password"
              />

              <PasswordField
                id="new-password"
                label="New password"
                hint="At least 8 characters."
                value={next}
                onChange={setNext}
                autoComplete="new-password"
              />

              <PasswordField
                id="confirm-password"
                label="Repeat new password"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
              />

              <button
                type="submit"
                disabled={savingPassword}
                className="rounded-[var(--radius-control)] bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
              >
                {savingPassword ? 'Changing…' : 'Change password'}
              </button>

              {passwordNote && <Notice tone={passwordNote.tone}>{passwordNote.text}</Notice>}
            </form>
          </section>
        </div>
      </PageBody>
    </AppShell>
  )
}
