// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InventoryTabs } from './InventoryTabs'

vi.mock('next/navigation', () => ({ usePathname: () => '/inventory' }))

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
})
