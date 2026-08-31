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
  expect(screen.getByRole('link', { name: 'Ambassadors' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Inventory and forecasting' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Product costs' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Ad accounts' })).toBeDefined()
  // The one-word catch-all header is gone.
  expect(screen.queryByText('Analytics')).toBeNull()
})

/**
 * The Gorgias sidebar collapses per subject, and the client asked for the
 * same: click a group name, its pages fold away, and the choice survives a
 * reload. Collapse is a DESKTOP behaviour - the mobile strip always shows
 * everything - so the assertions read the lg-only class and aria state
 * rather than jsdom visibility, which knows no breakpoints.
 */
describe('collapsible groups', () => {
  beforeEach(() => localStorage.clear())

  it('folds a group when its header is clicked, and remembers it', async () => {
    const { unmount } = setup()

    const header = screen.getByRole('button', { name: /Operations/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    const items = document.getElementById(header.getAttribute('aria-controls')!)
    expect(items).toHaveClass('lg:hidden')

    unmount()
    setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Operations/ })).toHaveAttribute('aria-expanded', 'false'),
    )
  })

  it('never hides the group holding the page being read', async () => {
    // Overview holds /dashboard, the mocked current page.
    localStorage.setItem('sidebar-collapsed', JSON.stringify(['Overview', 'Support']))
    setup()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Overview/ })).toHaveAttribute('aria-expanded', 'true'),
    )
    // A group NOT holding the active page stays folded as stored.
    expect(screen.getByRole('button', { name: /Support/ })).toHaveAttribute('aria-expanded', 'false')
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
