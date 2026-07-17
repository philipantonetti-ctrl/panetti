// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ShopsClient } from './ShopsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/shops',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

const SHOP = {
  id: 's1', name: 'Panetti Norway', currency: 'NOK', wooUrl: '', connected: false, lastSyncAt: null,
}

function renderShops(shops = [SHOP]) {
  return render(
    <ToastProvider>
      <ShopsClient email="admin@test.local" shops={shops} />
    </ToastProvider>,
  )
}

describe('ShopsClient', () => {
  it('labels an unconnected shop "Not connected", not "Sample data"', () => {
    renderShops()
    expect(screen.getByText('Not connected')).toBeTruthy()
    expect(screen.queryByText('Sample data')).toBeNull()
  })

  it('a failed sync says so — never "Synced 0 orders"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sync failed' }), { status: 500 }),
    ))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))

    await waitFor(() => {
      expect(screen.getByText('Sync failed')).toBeTruthy()
    })
    expect(screen.queryByText(/Synced 0 orders/)).toBeNull()
  })

  it('offers an Add shop button and validates before posting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderShops([])

    fireEvent.click(screen.getByRole('button', { name: 'Add shop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByText('Give the shop a name and pick its currency')).toBeTruthy()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
