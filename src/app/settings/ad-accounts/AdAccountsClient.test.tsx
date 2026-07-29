// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { AdAccountsClient, type PlatformSetup, type Row } from './AdAccountsClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/ad-accounts',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const SHOPS = [
  { id: 's1', name: 'Panetti Norway' },
  { id: 's2', name: 'Panetti Sweden' },
]

const READY: PlatformSetup = {
  meta: { clientId: 'app' },
  google: { clientId: 'app', hasDeveloperToken: true },
}

const account = (over: Partial<Row>): Row => ({
  id: 'acc1',
  provider: 'meta',
  externalId: '123',
  name: 'Panetti NO Meta',
  currency: 'NOK',
  shopId: 's1',
  shopName: 'Panetti Norway',
  connectionLabel: null,
  lastSyncAt: '2026-07-29T05:00:00.000Z',
  lastError: null,
  ...over,
})

function renderPage(
  accounts: Row[],
  opts: { platform?: PlatformSetup; picker?: string | null } = {},
) {
  return render(
    <ToastProvider>
      <AdAccountsClient
        email="admin@test.local"
        shops={SHOPS}
        accounts={accounts}
        platform={opts.platform ?? READY}
        picker={opts.picker ?? null}
        initialError={null}
      />
    </ToastProvider>,
  )
}

describe('AdAccountsClient', () => {
  it('lists accounts with an honest status badge and who connected them', () => {
    renderPage([
      account({ connectionLabel: 'Philip Antonetti' }),
      account({ id: 'acc2', name: 'Broken Google', provider: 'google', lastError: 'The developer token is not approved.' }),
      account({ id: 'acc3', name: 'Fresh', lastSyncAt: null }),
    ])

    expect(screen.getByText('Panetti NO Meta')).toBeTruthy()
    expect(screen.getByText('via Philip Antonetti')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('Error').title).toBe('The developer token is not approved.')
    expect(screen.getByText('Never synced')).toBeTruthy()
  })

  it('keeps the connect buttons asleep until the platform setup exists', () => {
    renderPage([], { platform: { meta: null, google: { clientId: 'x', hasDeveloperToken: false } } })

    const fb = screen.getByText('Connect with Facebook').closest('button')
    expect(fb?.disabled).toBe(true)
    // Google without a developer token cannot list or sync anything yet.
    const g = screen.getByText('Connect with Google').closest('button')
    expect(g?.disabled).toBe(true)
  })

  it('links the connect buttons straight to the oauth start when ready', () => {
    renderPage([])
    const fb = screen.getByText('Connect with Facebook').closest('a')
    expect(fb?.getAttribute('href')).toBe('/api/ads/oauth/meta/start')
    const g = screen.getByText('Connect with Google').closest('a')
    expect(g?.getAttribute('href')).toBe('/api/ads/oauth/google/start')
  })

  it('still offers the manual path behind Advanced, with provider fields switching', () => {
    renderPage([])
    // The Google platform-setup card already shows one Developer token label.
    expect(screen.getAllByText('Developer token')).toHaveLength(1)

    fireEvent.click(screen.getByText('Advanced: paste credentials manually'))
    expect(screen.getByText('System user access token')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getAllByText('Developer token')).toHaveLength(2) // card + modal
    expect(screen.queryByText('System user access token')).toBeNull()
  })

  it('opens the picker from the callback redirect, pre-ticks the matches, and connects them', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/ads/connections/'))
        return new Response(
          JSON.stringify({
            provider: 'meta',
            label: 'Philip Antonetti',
            accounts: [
              { externalId: '901', name: 'Panetti Norway', currency: 'NOK', alreadyConnected: false, suggestedShopId: 's1' },
              { externalId: '902', name: 'Levoit - NO', currency: 'NOK', alreadyConnected: false, suggestedShopId: null },
              { externalId: '903', name: 'Old one', currency: 'NOK', alreadyConnected: true, suggestedShopId: null },
            ],
          }),
          { status: 200 },
        )
      if (url.includes('/api/ad-accounts/bulk')) {
        const body = JSON.parse(String(init?.body))
        expect(body.connectionId).toBe('conn-1')
        expect(body.accounts).toEqual([
          { externalId: '901', name: 'Panetti Norway', currency: 'NOK', shopId: 's1' },
        ])
        return new Response(JSON.stringify({ results: [{ ok: true, days: 365 }], skipped: [] }), { status: 200 })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPage([], { picker: 'conn-1' })

    await waitFor(() => expect(screen.getByText('Logged in as Philip Antonetti.', { exact: false })).toBeTruthy())

    // The confident match is ticked; the stranger is not; the connected one is locked.
    const norway = screen.getByRole('checkbox', { name: 'Panetti Norway' }) as HTMLInputElement
    const levoit = screen.getByRole('checkbox', { name: 'Levoit - NO' }) as HTMLInputElement
    const old = screen.getByRole('checkbox', { name: 'Old one' }) as HTMLInputElement
    expect(norway.checked).toBe(true)
    expect(levoit.checked).toBe(false)
    expect(old.checked).toBe(true)
    expect(old.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Connect ticked accounts' }))
    await waitFor(() =>
      expect(screen.getByText('Connected 1 account(s). History is importing.')).toBeTruthy(),
    )
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

  it('saves the platform setup and never demands a saved secret again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage([])

    fireEvent.change(screen.getByLabelText('meta client id'), { target: { value: 'new-app-id' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/ad-platform-apps')
    const body = JSON.parse(String(init.body))
    expect(body.provider).toBe('meta')
    expect(body.clientId).toBe('new-app-id')
    expect(body.clientSecret).toBe('') // blank = keep what is saved
  })
})
