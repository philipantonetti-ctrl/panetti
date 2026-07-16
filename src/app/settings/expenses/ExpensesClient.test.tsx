// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ExpensesClient } from './ExpensesClient'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/expenses',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

describe('ExpensesClient with no shops (the live production state)', () => {
  it('stops loading instead of spinning forever', async () => {
    render(<ExpensesClient email="admin@test.local" shops={[]} />)

    // The bug: loading starts true and load() bails before clearing it,
    // so "Loading…" never goes away and the page lies about its state.
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })
  })

  it('says why the table is empty, and points at connecting a shop', async () => {
    render(<ExpensesClient email="admin@test.local" shops={[]} />)

    await waitFor(() => {
      expect(screen.getByText('No shops connected yet.')).toBeTruthy()
    })

    const link = screen.getByRole('link', { name: 'connect one first' })
    expect(link.getAttribute('href')).toBe('/settings/shops')
  })

  it('does not offer an Add button that could not possibly save', async () => {
    render(<ExpensesClient email="admin@test.local" shops={[]} />)

    // An expense needs a shopId and a category list. With no shop there is
    // neither, so the modal could never save — do not offer the door.
    await waitFor(() => {
      expect(screen.queryByText('Loading…')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: '+ Add expense' })).toBeNull()
  })
})
