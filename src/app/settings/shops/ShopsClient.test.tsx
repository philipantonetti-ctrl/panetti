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
      new Response(JSON.stringify({ error: 'Woo is down' }), { status: 500 }),
    ))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))

    await waitFor(() => {
      expect(screen.getByText('Woo is down')).toBeTruthy()
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

  it('a first sync with more history left says to press again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { shopName: 'Panetti Norway', ok: true, ordersSynced: 4000, more: true },
            { shopName: 'Panetti Sweden', ok: true, ordersSynced: 2 },
          ],
        }),
        { status: 200 },
      ),
    ))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))

    await waitFor(() => {
      expect(
        screen.getByText(/Panetti Norway has more history to fetch\. Press Sync all again to continue\./),
      ).toBeTruthy()
    })
    expect(screen.getByText(/Synced 4002 orders from 2 shop\(s\)\./)).toBeTruthy()
  })

  it('names the last column Action and offers Delete on every row', () => {
    renderShops()
    expect(screen.getByRole('columnheader', { name: 'Action' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('a cancelled confirm deletes nothing', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('deletes a shop and says so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(screen.getByText('Panetti Norway deleted')).toBeTruthy()
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/shops/s1')
    expect(init.method).toBe('DELETE')
  })

  it('shows the server refusal when history protects a shop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'This shop has sales or expenses on record, so deleting it would erase that history.',
        }),
        { status: 409 },
      ),
    ))
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    renderShops()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(
        screen.getByText(
          'This shop has sales or expenses on record, so deleting it would erase that history.',
        ),
      ).toBeTruthy()
    })
  })

  it('adds a shop: fills the form, saves, and posts the trimmed name with the chosen currency', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ shop: { id: 's2', name: 'Panetti Norway', currency: 'NOK' } }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderShops([])

    fireEvent.click(screen.getByRole('button', { name: 'Add shop' }))

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Panetti Norway  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Currency' }))
    fireEvent.click(screen.getByRole('button', { name: 'NOK - Nkr' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // The name reached the server TRIMMED — not with the surrounding spaces typed in.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/shops')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Panetti Norway', currency: 'NOK' })

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Add shop' })).toBeNull()
    })
  })
})
