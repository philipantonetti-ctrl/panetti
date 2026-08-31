'use client'

import { useContext, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ToastContext } from '@/components/toast/useToast'
import { FreshBuild } from './FreshBuild'
import { Assistant } from '@/components/assistant/Assistant'

/**
 * The app shell.
 *
 * Navigation lives on the left and stays put. The page header carries the page's own
 * title AND its filters - which shops, which dates - because those are page context,
 * not account chrome. They never sit next to "sign out" again.
 */

type NavItem = {
  href: string
  label: string
  icon: React.ReactNode
  /** Other pages this entry owns, so a tab of its own does not unlight it. */
  owns?: string[]
}

/** Where the folded groups are remembered, per browser. */
const COLLAPSE_KEY = 'sidebar-collapsed'

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

const AMBASSADORS_ITEM: NavItem = {
  href: '/ambassadors',
  label: 'Ambassadors',
  icon: icon(
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  ),
}

/**
 * Grouped the way the Gorgias sidebar the client sent is: a handful of small
 * labelled subjects, not one eleven-entry column under a single word. Same
 * entries as before - he asked for a SHORTER sidebar once already, so a
 * regrouping must never quietly add one - only arranged by what the pages
 * are about: the money read first, the people answering customers, the money
 * spent acquiring them, and the physical side of the business.
 */
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
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
      {
        href: '/orders',
        label: 'Orders',
        icon: icon(
          <>
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
            <path d="M3 6h18" />
            <path d="M16 10a4 4 0 0 1-8 0" />
          </>,
        ),
      },
      {
        href: '/finance',
        label: 'Finance',
        icon: icon(
          <>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
            <path d="M6 15h4" />
          </>,
        ),
      },
    ],
  },
  {
    section: 'Support',
    items: [
      {
        href: '/support',
        label: 'Support AI',
        // It owns the Advisor briefing too: they are one place with two tabs.
        owns: ['/advisor'],
        // A headset. The rayed circle it replaces read as a brightness control,
        // which is not what this page is. Three shapes on whole coordinates, so
        // it stays crisp at the sixteen pixels it is actually drawn at.
        icon: icon(
          <>
            <path d="M5 13v-1a7 7 0 0 1 14 0v1" />
            <rect x="3" y="12" width="4" height="7" rx="1.5" />
            <rect x="17" y="12" width="4" height="7" rx="1.5" />
          </>,
        ),
      },
      {
        href: '/inbox',
        label: 'Inbox',
        icon: icon(
          <>
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.5 5h13l3.5 7v7H2v-7Z" />
          </>,
        ),
      },
    ],
  },
  {
    section: 'Marketing',
    items: [
      {
        href: '/marketing',
        label: 'Marketing',
        icon: icon(
          <>
            <path d="m3 11 18-5v12L3 14v-3Z" />
            <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
          </>,
        ),
      },
      AMBASSADORS_ITEM,
    ],
  },
  {
    section: 'Operations',
    items: [
      {
        href: '/delivery',
        label: 'Delivery',
        icon: icon(
          <>
            <path d="M3 7h11v10H3z" />
            <path d="M14 10h4l3 3v4h-7z" />
            <circle cx="7" cy="18" r="1.5" />
            <circle cx="17" cy="18" r="1.5" />
          </>,
        ),
      },
      {
        href: '/products',
        label: 'Products',
        icon: icon(
          <>
            <path d="M20 7 12 3 4 7v10l8 4 8-4V7Z" />
            <path d="m4 7 8 4 8-4" />
            <path d="M12 11v10" />
          </>,
        ),
      },
      {
        href: '/inventory',
        label: 'Inventory and forecasting',
        icon: icon(
          <>
            <path d="M3 7h18v5H3z" />
            <path d="M5 12v8h14v-8" />
            <path d="M10 16h4" />
          </>,
        ),
      },
      {
        href: '/b2b',
        label: 'B2B',
        icon: icon(
          <>
            <path d="M3 21h18" />
            <path d="M5 21V8l7-5 7 5v13" />
            <path d="M10 21v-6h4v6" />
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
        href: '/settings/ad-accounts',
        label: 'Ad accounts',
        icon: icon(
          <>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1" />
          </>,
        ),
      },
      // Affiliate (Addrevenue) deliberately has no sidebar entry: the client
      // asked for a shorter sidebar, so it lives as a tile on the Settings
      // page (SettingsTabs, Shop tab) like Users and Processing fees do.
      {
        href: '/settings/delivery',
        label: 'Delivery settings',
        icon: icon(
          <>
            <path d="M3 7h11v10H3z" />
            <path d="M14 10h4l3 3v4h-7z" />
            <circle cx="7" cy="18" r="1.5" />
            <circle cx="17" cy="18" r="1.5" />
          </>,
        ),
      },
      {
        href: '/settings',
        label: 'Settings',
        // The old gear's teeth were drawn from stacked arc shorthand that
        // renders lumpy at 16px; this is the standard rounded-tooth gear,
        // which stays crisp at this size.
        icon: icon(
          <>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
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

/** Marketing runs the ambassador program; their nav says exactly that. */
const MARKETING_NAV: { section: string; items: NavItem[] }[] = [
  { section: 'People', items: [AMBASSADORS_ITEM] },
]

function Wordmark({ home }: { home: string }) {
  return (
    <Link href={home} className="flex items-center gap-2 px-2.5 py-1">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink text-[11px] font-bold text-white">
        p
      </span>
      <span className="text-[13px] font-semibold tracking-tight text-ink">panetti-analytics</span>
    </Link>
  )
}

export function AppShell({
  email,
  children,
  nav = true,
  role = 'ADMIN',
}: {
  email: string
  children: React.ReactNode
  nav?: boolean // the ambassador portal has no admin nav
  role?: 'ADMIN' | 'MARKETING' // marketing sees only the ambassador program
}) {
  const pathname = usePathname()
  const router = useRouter()
  // useContext directly, not the useToast() hook: AppShell wraps every page,
  // including ones a test renders without a ToastProvider ancestor. useToast()
  // throws in that case; here the toast is a courtesy, and the one thing that
  // must always hold - never navigate to /login on a failed sign-out - does
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

  const isActive = (item: NavItem) => {
    if (item.href === '/settings') return pathname === '/settings'
    const paths = [item.href, ...(item.owns ?? [])]
    return paths.some((p) => pathname.startsWith(p))
  }

  const groups = role === 'MARKETING' ? MARKETING_NAV : NAV
  const home = role === 'MARKETING' ? '/ambassadors' : '/dashboard'

  /**
   * Which groups are folded shut. Starts empty (everything open) and loads
   * the remembered choice after mount rather than in the initializer: the
   * server has no localStorage, and reading it during render would make the
   * first client paint disagree with the HTML it is hydrating.
   *
   * The group holding the page being read is always dropped from the set: a
   * sidebar that hides the lit entry for the page on screen reads as broken,
   * so arriving at a page quietly unfolds its group.
   */
  const [collapsed, setCollapsed] = useState<string[]>([])
  useEffect(() => {
    let stored: string[] = []
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')
      if (Array.isArray(raw)) stored = raw.filter((s): s is string => typeof s === 'string')
    } catch {
      // A cleared or blocked store simply means everything opens.
    }
    const activeSection = groups.find((g) => g.items.some(isActive))?.section
    // One deliberate post-mount set. The fold memory lives in localStorage,
    // which the server render cannot read, so the first client render catches
    // up exactly once - the React-documented pattern for client-only state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(stored.filter((s) => s !== activeSection))
    // isActive is stable per pathname; groups per role.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, role])

  function toggleGroup(section: string) {
    setCollapsed((prev) => {
      const next = prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section]
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
      } catch {
        // Fold still works for this visit; it is only the memory that is lost.
      }
      return next
    })
  }

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[232px_1fr]">
      {/* Every page heals itself when a newer deployment appears. */}
      <FreshBuild />

      {/* Sidebar - a column on desktop, a strip on smaller screens. */}
      <aside className="border-line bg-panel lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-r">
        <div className="flex items-center justify-between border-b border-line px-3 py-3 lg:block lg:border-b-0 lg:py-4">
          <Wordmark home={home} />
        </div>

        {/* Six labelled groups are taller than three: the column scrolls on
            short laptop screens rather than clipping Setup off the bottom. */}
        {nav && (
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:gap-0 lg:overflow-y-auto lg:overflow-x-visible lg:pb-0">
            {groups.map((group) => {
              const open = !collapsed.includes(group.section)
              const itemsId = `nav-group-${group.section.toLowerCase()}`
              return (
                <div key={group.section} className="lg:mb-3">
                  {/* The whole header row is the control, the way Gorgias
                      folds its sections. Desktop only: the mobile strip has
                      no headers and always shows every entry. No height
                      animation - layout moves are banned - the chevron
                      carries the state change. */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.section)}
                    aria-expanded={open}
                    aria-controls={itemsId}
                    className="hidden w-full items-center justify-between rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[12px] font-semibold tracking-wide text-muted transition-colors duration-150 hover:text-ink lg:flex"
                  >
                    {group.section}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className={`text-faint transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                  <div
                    id={itemsId}
                    className={`flex gap-1 lg:flex-col lg:gap-0.5 ${open ? '' : 'lg:hidden'}`}
                  >
                    {group.items.map((item) => (
                      <NavLink key={item.href} item={item} active={isActive(item)} />
                    ))}
                  </div>
                </div>
              )
            })}
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

      {/* The assistant follows the admin around the product. Not for marketing
          or the ambassador portal (which renders this shell with nav={false}):
          it can read company money, and the route's own assertAdmin is the
          real gate - this only declines to show the door. */}
      {nav && role === 'ADMIN' && <Assistant />}
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
