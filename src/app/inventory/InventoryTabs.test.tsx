// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InventoryTabs } from './InventoryTabs'

// Mutable so a test can put us on a child route. The exact-versus-prefix rule is
// invisible at /inventory itself, where both comparisons are true.
const route = vi.hoisted(() => ({ current: '/inventory' }))
vi.mock('next/navigation', () => ({ usePathname: () => route.current }))

beforeEach(() => {
  route.current = '/inventory'
})

describe('InventoryTabs', () => {
  it('offers all four views from one place', () => {
    render(<InventoryTabs />)
    for (const label of ['Forecast', 'Stock', 'Purchase orders', 'Suppliers & lead times']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy()
    }
  })

  it('marks the view you are on, so the buttons say where you are', () => {
    render(<InventoryTabs />)
    expect(screen.getByRole('link', { name: 'Forecast' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Stock' }).getAttribute('aria-current')).toBeNull()
  })

  it('lights the child route you are on, and leaves Forecast alone', () => {
    // The reason the index uses an exact match rather than a prefix. Swap the
    // ternary for a blanket startsWith and this is the only test that fails —
    // every other assertion in this file passes either way.
    route.current = '/inventory/purchase-orders'
    render(<InventoryTabs />)

    expect(
      screen.getByRole('link', { name: 'Purchase orders' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(screen.getByRole('link', { name: 'Forecast' }).getAttribute('aria-current')).toBeNull()
  })
})
