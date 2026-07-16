'use client'

import { useContext } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ToastContext } from '@/components/toast/useToast'

/**
 * The app shell.
 *
 * Navigation lives on the left and stays put. The page header carries the page's own
 * title AND its filters — which shops, which dates — because those are page context,
 * not account chrome. They never sit next to "sign out" again.
 */

type NavItem = { href: string; label: string; icon: React.ReactNode }

const icon = (path: React.ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
)

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Analytics',
    items: [
      {
        href: '/dashboard',
        label: 'Dashboard',
        icon: icon(
          <>
            <path d="M3 3v18h18" />
            <path d="m7 15 4-5 3 3 5-7" />
          </>,
        ),
      },
    ],
  },
  {
    section: 'Costs',
    items: [
      {
        href: '/settings/costs',
        label: 'Product costs',
        icon: icon(
          <>
            <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
            <path d="m3 8 9 5 9-5" />
            <path d="M12 13v8" />
          </>,
        ),
      },
      {
        href: '/settings/expenses',
        label: 'Operational expenses',
        icon: icon(
          <>
            <path d="M5 3h11l3 3v15l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
            <path d="M9 8h6M9 12h6M9 16h3" />
          </>,
        ),
      },
    ],
  },
  {
    section: 'Setup',
    items: [
      {
        href: '/settings/shops',
        label: 'Shops',
        icon: icon(
          <>
            <path d="M3 9h18l-1.5-5H4.5L3 9Z" />
            <path d="M5 9v11h14V9" />
            <path d="M9 20v-6h6v6" />
          </>,
        ),
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: icon(
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 3V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.6c.6.2 1.3.1 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </>,
        ),
      },
    ],
  },
]

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-[13px] transition-colors duration-150 ${
        active
          ? 'bg-accent-soft font-semibold text-accent-ink'
          : 'text-muted hover:bg-panel hover:text-ink'
      }`}
    >
      <span className={active ? 'text-accent' : 'text-faint'}>{item.icon}</span>
      {item.label}
    </Link>
  )
}

function Wordmark() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2 px-2.5 py-1">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink text-[11px] font-bold text-white">
        e
      </span>
      <span className="text-[13px] font-semibold tracking-tight text-ink">ecom-analytics</span>
    </Link>
  )
}

export function AppShell({
  email,
  children,
  nav = true,
}: {
  email: string
  children: React.ReactNode
  nav?: boolean // the ambassador portal has no admin nav
}) {
  const pathname = usePathname()
  const router = useRouter()
  // useContext directly, not the useToast() hook: AppShell wraps every page,
  // including ones a test renders without a ToastProvider ancestor. useToast()
  // throws in that case; here the toast is a courtesy, and the one thing that
  // must always hold — never navigate to /login on a failed sign-out — does
  // not depend on it being present.
  const toast = useContext(ToastContext)

  async function signOut() {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (!res.ok) {
        // Do NOT navigate. Landing on /login while the cookie is still valid
        // tells the user they are signed out when they are not.
        toast?.error('Could not sign you out. Please try again.')
        return
      }
      router.push('/login')
      router.refresh()
    } catch {
      toast?.error('Could not reach the server. You are still signed in.')
    }
  }

  const isActive = (href: string) =>
    href === '/settings' ? pathname === '/settings' : pathname.startsWith(href)

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[232px_1fr]">
      {/* Sidebar — a column on desktop, a strip on smaller screens. */}
      <aside className="border-line bg-panel lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r">
        <div className="flex items-center justify-between border-b border-line px-3 py-3 lg:block lg:border-b-0 lg:py-4">
          <Wordmark />
        </div>

        {nav && (
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0">
            {NAV.map((group) => (
              <div key={group.section} className="lg:mb-5">
                <p className="hidden px-2.5 pb-1.5 text-[11px] font-semibold tracking-wide text-faint lg:block">
                  {group.section}
                </p>
                <div className="flex gap-1 lg:flex-col lg:gap-0.5">
                  {group.items.map((item) => (
                    <NavLink key={item.href} item={item} active={isActive(item.href)} />
                  ))}
                </div>
              </div>
            ))}
          </nav>
        )}

        {/* Your own account is reachable from every screen, ambassadors included. */}
        <div className="hidden border-t border-line p-3 lg:block">
          <p className="truncate px-2.5 pb-1 text-[12px] text-muted" title={email}>
            {email}
          </p>

          <Link
            href="/account"
            aria-current={pathname.startsWith('/account') ? 'page' : undefined}
            className={`block rounded-[var(--radius-control)] px-2.5 py-1.5 text-[12px] transition-colors duration-150 ${
              pathname.startsWith('/account')
                ? 'bg-accent-soft font-semibold text-accent-ink'
                : 'text-muted hover:bg-surface hover:text-ink'
            }`}
          >
            Your account
          </Link>

          <button
            onClick={signOut}
            className="mt-0.5 w-full rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[12px] text-muted transition-colors duration-150 hover:bg-surface hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        {/* On small screens the account controls need a home. */}
        <div className="flex items-center justify-end gap-3 border-b border-line px-4 py-2 text-[12px] text-muted lg:hidden">
          <span className="truncate">{email}</span>
          <Link href="/account" className="text-ink underline-offset-2 hover:underline">
            Account
          </Link>
          <button onClick={signOut} className="text-ink underline-offset-2 hover:underline">
            Sign out
          </button>
        </div>

        {children}
      </div>
    </div>
  )
}

/**
 * The page's own header: what you are looking at (title) and what you are looking
 * through (the filters). They belong together.
 */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children?: React.ReactNode
}) {
  return (
    <header
      className="sticky top-0 border-b border-line bg-canvas"
      style={{ zIndex: 'var(--z-sticky)' }}
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>

        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </header>
  )
}

/** Every page body sits in the same column, so nothing shifts between screens. */
export function PageBody({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
}
