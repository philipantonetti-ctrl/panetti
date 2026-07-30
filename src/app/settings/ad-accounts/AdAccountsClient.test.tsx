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

const READY: PlatformSetup = { meta: true, google: true }

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
  opts: { platform?: PlatformSetup; picker?: string | null; notice?: string | null } = {},
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
        initialNotice={opts.notice ?? null}
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

  it('offers both connect buttons as real links when the server is configured', () => {
    renderPage([])
    expect(screen.getByText('Connect with Facebook').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/meta/start',
    )
    expect(screen.getByText('Connect with Google').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/google/start',
    )
  })

  it('links the Google connect button straight to the oauth start when ready', () => {
    renderPage([])
    expect(screen.getByText('Connect with Google').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/google/start',
    )
  })

  it('links Connect with Facebook straight to the oauth start when ready', () => {
    renderPage([])
    expect(screen.getByText('Connect with Facebook').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/meta/start',
    )
  })

  it('says so plainly when a platform is not configured on the server', async () => {
    renderPage([], { platform: { meta: false, google: true } })

    // Not a link: pressing it would only bounce off Facebook with a worse error.
    expect(screen.getByText('Connect with Facebook').closest('a')).toBeNull()
    fireEvent.click(screen.getByText('Connect with Facebook'))
    await waitFor(() =>
      expect(
        screen.getByText('Facebook connect is not set up on the server yet.'),
      ).toBeTruthy(),
    )
    // Google is unaffected.
    expect(screen.getByText('Connect with Google').closest('a')).toBeTruthy()
  })

  it('asks for the token nowhere on the page any more', () => {
    renderPage([])
    // One button per platform, like BeProfit. The per-account paste behind
    // Advanced is the only place a token is still typed.
    expect(screen.queryByLabelText('System user access token')).toBeNull()
    expect(screen.queryByText('Meta: paste a system user token')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save token' })).toBeNull()
  })

  it('asks the client for no app credentials anywhere', () => {
    renderPage([])
    expect(screen.queryByText('Platform setup')).toBeNull()
    expect(screen.queryByLabelText('meta client id')).toBeNull()
    expect(screen.queryByLabelText('google client id')).toBeNull()
    expect(screen.queryByLabelText('google developer token')).toBeNull()
    expect(screen.queryByText('Callback URL:')).toBeNull()
  })

  it('still offers the manual path behind Advanced, with provider fields switching', () => {
    renderPage([])
    // The setup cards are gone, so the modal is the only place this label lives.
    expect(screen.queryAllByText('Developer token')).toHaveLength(0)

    fireEvent.click(screen.getByText('Advanced: paste credentials manually'))
    expect(screen.getByText('Access token for this account')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getAllByText('Developer token')).toHaveLength(1) // modal only
    expect(screen.queryByText('Access token for this account')).toBeNull()
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

  // Two tests lived here that asserted messages nothing can produce any more:
  // the "the Facebook app was just fixed, press Connect again" notice, which
  // WAS the loop, and the save-time App Domains warning. Both died with
  // ensureMetaApp. A green test guarding an impossible message is worse than
  // no test — it reads as coverage while proving nothing.
})
