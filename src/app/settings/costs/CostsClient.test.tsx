// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CostsClient } from './CostsClient'

// AppShell is a client component: it reads the current route and pushes on sign-out.
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/costs',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

describe('CostsClient with no shops (the live production state)', () => {
  // This page shows no "Loading…" text — it loads as four skeleton rows.
  const skeletons = (container: HTMLElement) => container.querySelectorAll('.skeleton')

  it('stops loading instead of spinning forever', async () => {
    const { container } = render(<CostsClient email="admin@test.local" shops={[]} />)

    // The bug: loading starts true and load() bails before clearing it, so the
    // skeleton rows shimmer for ever and the page lies about its state.
    await waitFor(() => {
      expect(skeletons(container).length).toBe(0)
    })
  })

  it('says why the table is empty, and points at connecting a shop', async () => {
    render(<CostsClient email="admin@test.local" shops={[]} />)

    await waitFor(() => {
      expect(screen.getByText('No shops connected yet.')).toBeTruthy()
    })

    const link = screen.getByRole('link', { name: 'connect one first' })
    expect(link.getAttribute('href')).toBe('/settings/shops')
  })
})
