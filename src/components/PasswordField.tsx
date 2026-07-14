'use client'

import { useState } from 'react'

/**
 * A password box you can look inside.
 *
 * Hiding what you type protects you from someone reading over your shoulder, but it also
 * causes most failed sign-ins. So we hide it by default and let you check it, which is
 * exactly the trade people expect.
 */
export function PasswordField({
  id,
  label,
  hint,
  value,
  onChange,
  autoComplete = 'current-password',
  required = false,
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  required?: boolean
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-medium text-ink">
        {label}
      </label>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}

      <div className="relative mt-1">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required={required}
          className="w-full rounded-[var(--radius-control)] border border-line bg-surface py-2 pl-3 pr-10 text-[13px] text-ink placeholder:text-faint"
        />

        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          title={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint transition-colors duration-150 hover:text-ink"
        >
          {visible ? (
            // Eye with a line through it: the password is showing, click to hide.
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 9 4.5 10 6a15 15 0 0 1-2.6 3.2" />
              <path d="M6.6 6.8A15.5 15.5 0 0 0 2 12c1 1.5 5 6 10 6a9.7 9.7 0 0 0 4-.9" />
              <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              <path d="m3 3 18 18" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
