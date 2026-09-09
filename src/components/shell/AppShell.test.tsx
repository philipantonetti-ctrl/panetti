// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push, refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const { AppShell } = await import('./AppShell')
const { ToastProvider } = await import('@/components/toast/ToastProvider')

beforeEach(() => {
  push.mockClear()
  vi.restoreAllMocks()
})

const setup = () =>
  render(<ToastProvider><AppShell email="admin@test.local"><p>page</p></AppShell></ToastProvider>)

// AppShell renders the sign-out control twice - once for the desktop sidebar
// (hidden below the lg breakpoint) and once for the mobile top bar (hidden at
// and above it). jsdom does not apply Tailwind's responsive `hidden` classes,
// so both buttons are present in the tree at once; either exercises the same
// signOut() handler, so clicking the first is representative.
const signOutButton = () => screen.getAllByRole('button', { name: 'Sign out' })[0]

describe('AppShell sign-out', () => {
  // The bug: it navigated regardless, so the user believed they were signed
  // out while the cookie was still live.
  it('does NOT navigate when the logout fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    setup()
    fireEvent.click(signOutButton())

    await waitFor(() => expect(screen.getByText(/could not sign you out/i)).toBeDefined())
    expect(push).not.toHaveBeenCalled()   // THE assertion
  })

  it('does NOT navigate when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    setup()
    fireEvent.click(signOutButton())

    await waitFor(() => expect(screen.getByText(/still signed in|could not reach/i)).toBeDefined())
    expect(push).not.toHaveBeenCalled()
  })

  it('DOES navigate to /login on a successful sign-out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    setup()
    fireEvent.click(signOutButton())

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'))
  })
})

/**
 * The Gorgias sidebar the client sent: a handful of small labelled groups,
 * each a subject, instead of one eleven-entry column under a single word.
 * Same entries as before - the client asked for a SHORTER sidebar once
 * already, so nothing is added - only arranged by what the pages are about.
 */
it('groups the sidebar by subject, with every entry still present', () => {
  setup()

  // getAllByText: 'Marketing' is both a group header and the page link inside it.
  for (const section of ['Overview', 'Support', 'Marketing', 'Operations', 'Costs', 'Setup']) {
    expect(screen.getAllByText(section).length).toBeGreaterThan(0)
  }
  // One representative entry per group, so a regrouping cannot drop a page.
  expect(screen.getByRole('link', { name: 'Dashboard' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Support AI' })).toBeDefined()
  // The Agents page the client asked for, inside the Support group.
  expect(screen.getByRole('link', { name: 'Agents' }).getAttribute('href')).toBe('/support/agents')
  // Advisor moved out of Support AI's tabs to its own entry, below Inbox.
  const support = screen.getAllByRole('link').filter((a) =>
    ['/support', '/support/agents', '/inbox', '/advisor'].includes(a.getAttribute('href')!),
  )
  expect(support.map((a) => a.getAttribute('href'))).toEqual([
    '/support',
    '/support/agents',
    '/inbox',
    '/advisor',
  ])
  expect(screen.getByRole('link', { name: 'Ambassadors' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Inventory and forecasting' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Product costs' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Ad accounts' })).toBeDefined()
  // The one-word catch-all header is gone.
  expect(screen.queryByText('Analytics')).toBeNull()
})

/**
 * The client's second ask on the folding sidebar: arrive at the site and
 * every group starts CLOSED, except the one holding the page on screen. What
 * a person opens by hand lasts for the visit (sessionStorage) and resets on
 * the next one. Collapse is a DESKTOP behaviour - the mobile strip always
 * shows everything - so the assertions read aria state and the lg-only
 * class rather than jsdom visibility, which knows no breakpoints.
 */
describe('collapsible groups', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it('starts every group closed, except the one holding the page being read', async () => {
    setup()

    // Overview holds /dashboard, the mocked current page.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Overview/ })).toHaveAttribute('aria-expanded', 'true'),
    )
    for (const section of ['Support', 'Marketing', 'Operations', 'Costs', 'Setup']) {
      expect(screen.getByRole('button', { name: new RegExp(section) })).toHaveAttribute(
        'aria-expanded',
        'false',
      )
    }
    const closed = screen.getByRole('button', { name: /Operations/ })
    expect(document.getElementById(closed.getAttribute('aria-controls')!)).toHaveClass('lg:hidden')
  })

  it('opens a group on click and keeps it open for the visit, not forever', async () => {
    const { unmount } = setup()

    const header = await screen.findByRole('button', { name: /Operations/ })
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')

    // Same visit (sessionStorage intact): still open after a remount.
    unmount()
    const again = setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Operations/ })).toHaveAttribute('aria-expanded', 'true'),
    )

    // A NEW visit starts closed again.
    again.unmount()
    sessionStorage.clear()
    setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Overview/ })).toHaveAttribute('aria-expanded', 'true'),
    )
    expect(screen.getByRole('button', { name: /Operations/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('sets the group name a readable step above the old micro label', () => {
    setup()
    expect(screen.getByRole('button', { name: /Overview/ })).toHaveClass('text-[12px]')
  })
})

it('offers B2B to an admin and never to marketing', () => {
  const { unmount } = render(<AppShell email="a@b.test">x</AppShell>)
  expect(screen.getByRole('link', { name: 'B2B' }).getAttribute('href')).toBe('/b2b')
  unmount()

  render(<AppShell email="a@b.test" role="MARKETING">x</AppShell>)
  expect(screen.queryByRole('link', { name: 'B2B' })).toBeNull()
})

/**
 * The operations manager's sidebar: Orders, and the four Operations pages.
 * Nothing else - a menu offering the dashboard would be a door that bounces
 * him, and the pages behind those entries are the owner's money.
 */
describe('the operations sidebar', () => {
  const HIS = ['Today', 'Orders', 'Finance', 'Delivery', 'Products', 'Inventory and forecasting', 'B2B']
  const NOT_HIS = [
    'Dashboard', 'Support AI', 'Agents', 'Inbox', 'Advisor briefing',
    'Marketing', 'Ambassadors', 'Product costs', 'Operational expenses',
    'Shops', 'Ad accounts', 'Delivery settings', 'Settings',
  ]

  it('offers his five tabs and nothing else', () => {
    render(<ToastProvider><AppShell email="ops@test.local" role="OPERATIONS"><p>page</p></AppShell></ToastProvider>)

    for (const label of HIS) {
      expect(screen.getByRole('link', { name: label }), label).toBeDefined()
    }
    for (const label of NOT_HIS) {
      expect(screen.queryByRole('link', { name: label }), label).toBeNull()
    }
  })

  it('names the two groups those five sit in', () => {
    render(<ToastProvider><AppShell email="ops@test.local" role="OPERATIONS"><p>page</p></AppShell></ToastProvider>)
    expect(screen.getByRole('button', { name: /Overview/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /Operations/ })).toBeDefined()
    for (const section of ['Support', 'Marketing', 'Costs', 'Setup']) {
      expect(screen.queryByRole('button', { name: new RegExp(section) }), section).toBeNull()
    }
  })

  it('points its wordmark at Today, which is where he lands', () => {
    render(<ToastProvider><AppShell email="ops@test.local" role="OPERATIONS"><p>page</p></AppShell></ToastProvider>)
    expect(screen.getByRole('link', { name: /panetti-analytics/ }).getAttribute('href')).toBe('/today')
  })

  /**
   * The client asked for a SHORTER sidebar once already, so his manager's new
   * page does not quietly add an entry to his. He can still open /today by
   * typing it, which is how he checks what his manager sees.
   */
  it("does not add Today to the owner's sidebar", () => {
    render(<ToastProvider><AppShell email="a@b.test"><p>page</p></AppShell></ToastProvider>)
    expect(screen.queryByRole('link', { name: 'Today' })).toBeNull()
  })

  /**
   * The assistant can read company money, so it stays with the owner. The
   * routes behind it are the real gate; this only declines to show the door.
   */
  it('does not follow him around with the assistant', () => {
    const { unmount } = render(<ToastProvider><AppShell email="ops@test.local" role="OPERATIONS"><p>page</p></AppShell></ToastProvider>)
    expect(screen.queryByRole('button', { name: /assistant/i })).toBeNull()
    unmount()

    render(<ToastProvider><AppShell email="a@b.test"><p>page</p></AppShell></ToastProvider>)
    expect(screen.getByRole('button', { name: /assistant/i })).toBeDefined()
  })
})
