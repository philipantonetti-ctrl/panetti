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

  it('walks you to the setup when the Google connect button is pressed too early', async () => {
    renderPage([], { platform: { meta: null, google: { clientId: 'x', hasDeveloperToken: false } } })

    // Not a link yet — the login flow would only bounce back with an error.
    expect(screen.getByText('Connect with Google').closest('a')).toBeNull()
    fireEvent.click(screen.getByText('Connect with Google'))
    await waitFor(() =>
      expect(
        screen.getByText('One-time setup needed first. Two minutes, the steps are right below.'),
      ).toBeTruthy(),
    )
  })

  it('links the Google connect button straight to the oauth start when ready', () => {
    renderPage([])
    expect(screen.getByText('Connect with Google').closest('a')?.getAttribute('href')).toBe(
      '/api/ads/oauth/google/start',
    )
  })

  it('offers Meta a token box instead of a Facebook login that never worked', () => {
    renderPage([])
    expect(screen.queryByText('Connect with Facebook')).toBeNull()
    expect(screen.getByLabelText('System user access token')).toBeTruthy()
  })

  it('saves a pasted Meta token and opens the picker on what comes back', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ connectionId: 'conn1', label: 'Philip', expiresAt: null }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPage([])

    fireEvent.change(screen.getByLabelText('System user access token'), {
      target: { value: 'EAABpasted' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/ads/connections/meta')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'EAABpasted' })
    // The picker took over, which is the whole point of pasting once.
    await waitFor(() => expect(screen.getByText('Pick the ad accounts')).toBeTruthy())
  })

  it('keeps the card open and says why when Facebook refuses the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'This token has no ads_read permission.' }, { status: 400 }),
      ),
    )
    renderPage([])

    fireEvent.change(screen.getByLabelText('System user access token'), {
      target: { value: 'bad' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))

    await waitFor(() =>
      expect(screen.getByText('This token has no ads_read permission.')).toBeTruthy(),
    )
    expect(screen.queryByText('Pick the ad accounts')).toBeNull()
  })

  it('still offers the manual path behind Advanced, with provider fields switching', () => {
    renderPage([])
    // The Google platform-setup card already shows one Developer token label.
    expect(screen.getAllByText('Developer token')).toHaveLength(1)

    fireEvent.click(screen.getByText('Advanced: paste credentials manually'))
    // Named apart from the Meta card's own token field, which is always on
    // the page — two identical labels would read the same to a screen reader.
    expect(screen.getByText('Access token for this account')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Google' }))
    expect(screen.getAllByText('Developer token')).toHaveLength(2) // card + modal
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

  it('saves the platform setup and never demands a saved secret again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage([])

    fireEvent.change(screen.getByLabelText('google client id'), { target: { value: 'new-app-id' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/ad-platform-apps')
    const body = JSON.parse(String(init.body))
    expect(body.provider).toBe('google')
    expect(body.clientId).toBe('new-app-id')
    expect(body.clientSecret).toBe('') // blank = keep what is saved
  })

  it('asks Meta for nothing but the token', () => {
    renderPage([])
    // The App ID and secret card is gone. It only ever powered an optional
    // check, and requiring it put a wall in front of the one field that
    // matters. Google keeps its card, because Google genuinely needs it.
    expect(screen.queryByLabelText('meta client id')).toBeNull()
    expect(screen.queryByText('Meta app')).toBeNull()
    expect(screen.getByLabelText('System user access token')).toBeTruthy()
    expect(screen.getByLabelText('google client id')).toBeTruthy()
  })
})
