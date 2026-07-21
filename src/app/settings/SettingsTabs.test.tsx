// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsTabs } from './SettingsTabs'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

describe('SettingsTabs', () => {
  it('opens on Costs with the cost tiles', () => {
    render(<SettingsTabs />)
    expect(screen.getByRole('link', { name: /Product Costs/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Processing Fees/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /General settings/ })).toBeNull()
  })

  it('switches tabs: Shop shows the per-webshop settings', () => {
    render(<SettingsTabs />)
    fireEvent.click(screen.getByRole('tab', { name: 'Shop' }))
    const general = screen.getByRole('link', { name: /General settings/ })
    expect(general.getAttribute('href')).toBe('/settings/shop')
    expect(screen.queryByRole('link', { name: /Product Costs/ })).toBeNull()
  })

  it('has the four BeProfit tabs, and Workspace holds the new-shop defaults', () => {
    render(<SettingsTabs />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Costs', 'Shop', 'User', 'Workspace',
    ])
    fireEvent.click(screen.getByRole('tab', { name: 'User' }))
    expect(screen.getByRole('link', { name: /Ambassadors/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }))
    const defaults = screen.getByRole('link', { name: /Workspace defaults/ })
    expect(defaults.getAttribute('href')).toBe('/settings/general')
  })
})
