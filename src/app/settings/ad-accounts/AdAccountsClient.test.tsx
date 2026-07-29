// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { AdAccountsClient, type Row } from './AdAccountsClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ad-accounts',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const SHOPS = [
  { id: 's1', name: 'Panetti Norway' },
  { id: 's2', name: 'Panetti Sweden' },
]

const account = (over: Partial<Row>): Row => ({
  id: 'acc1',
  provider: 'meta',
  externalId: '123',
  name: 'Panetti NO Meta',
  currency: 'NOK',
  shopId: 's1',
  shopName: 'Panetti Norway',
  lastSyncAt: '2026-07-29T05:00:00.000Z',
  lastError: null,
  ...over,
})

function renderPage(accounts: Row[]) {
  return render(
    <ToastProvider>
      <AdAccountsClient email="admin@test.local" shops={SHOPS} accounts={accounts} />
    </ToastProvider>,
  )
}

describe('AdAccountsClient', () => {
  it('lists accounts with an honest status badge', () => {
    renderPage([
      account({}),
      account({ id: 'acc2', name: 'Broken Google', provider: 'google', lastError: 'The developer token is not approved.' }),
      account({ id: 'acc3', name: 'Fresh', lastSyncAt: null }),
    ])

    expect(screen.getByText('Panetti NO Meta')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Error').title).toBe('The developer token is not approved.')
    expect(screen.getByText('Never synced')).toBeTruthy()
  })

  it('switches the credential fields with the provider', () => {
    renderPage([])
    fireEvent.click(screen.getByText('Connect account'))

    // Meta first.
    expect(screen.getByText('System user access token')).toBeTruthy()
    expect(screen.queryByText('Developer token')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getByText('Developer token')).toBeTruthy()
    expect(screen.getByText('Refresh token')).toBeTruthy()
    expect(screen.queryByText('System user access token')).toBeNull()
  })

  it("shows the server's words and keeps the modal open when connecting fails", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid OAuth access token' }), { status: 400 }),
      ),
    )
    renderPage([])

    fireEvent.click(screen.getByText('Connect account'))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getByText('Invalid OAuth access token')).toBeTruthy())
    // Still open: what they pasted is still in front of them.
    expect(screen.getByText('Connect ad account')).toBeTruthy()
  })

  it('reports the sync results account by account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { name: 'A', ok: true, days: 35 },
              { name: 'B', ok: false, days: 0, error: 'Invalid OAuth access token' },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    renderPage([account({})])

    fireEvent.click(screen.getByText('Sync now'))
    await waitFor(() =>
      expect(
        screen.getByText('Synced 1 account(s). Failed: B (Invalid OAuth access token)'),
      ).toBeTruthy(),
    )
  })
})
