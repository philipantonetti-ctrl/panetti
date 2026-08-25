// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import {
  AdAccountsClient,
  type Connections,
  type PlatformSetup,
  type Row,
} from './AdAccountsClient'

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

const NO_LOGINS: Connections = { meta: null, google: null }

function renderPage(
  accounts: Row[],
  opts: {
    platform?: PlatformSetup
    picker?: string | null
    notice?: string | null
    connections?: Connections
  } = {},
) {
  return render(
    <ToastProvider>
      <AdAccountsClient
        email="admin@test.local"
        shops={SHOPS}
        accounts={accounts}
        platform={opts.platform ?? READY}
        connections={opts.connections ?? NO_LOGINS}
        picker={opts.picker ?? null}
        initialError={null}
        initialNotice={opts.notice ?? null}
      />
    </ToastProvider>,
  )
}

describe('which login is in use', () => {
  // The buttons cannot say this: "Connect with Facebook" reads identically
  // whether nothing is connected or nine accounts are, and the only other clue
  // is the small "via" line under each account name. Someone who has just
  // connected looks at the same button they pressed and wonders whether it
  // worked.
  it('names the Facebook login, so the page says it is connected', () => {
    renderPage([account({})], {
      connections: {
        meta: { label: 'Jacob Kjos Hanssen', expiresAt: '2026-09-29T00:00:00.000Z', expired: false },
        google: null,
      },
    })
    expect(screen.getByText(/Facebook: connected as Jacob Kjos Hanssen/)).toBeTruthy()
  })

  // A Meta token lasts about 60 days and then every sync fails. The date is the
  // only warning anyone gets before that.
  it('says when the login has to be renewed', () => {
    const at = '2026-09-29T00:00:00.000Z'
    renderPage([account({})], {
      connections: {
        meta: { label: 'Jacob Kjos Hanssen', expiresAt: at, expired: false },
        google: null,
      },
    })
    expect(
      screen.getByText(new RegExp(`Renew by ${new Date(at).toLocaleDateString()}`)),
    ).toBeTruthy()
  })

  it('leads with the expiry once it has passed, since that is why syncs fail', () => {
    renderPage([account({})], {
      connections: {
        meta: { label: 'Jacob Kjos Hanssen', expiresAt: '2026-06-01T00:00:00.000Z', expired: true },
        google: null,
      },
    })
    expect(screen.getByText(/login expired/)).toBeTruthy()
    expect(screen.queryByText(/connected as Jacob Kjos Hanssen/)).toBeNull()
  })

  // A Google refresh token does not expire while the client stays published,
  // so there is no date to promise.
  it('names Google without inventing a renewal date', () => {
    renderPage([account({ provider: 'google' })], {
      connections: {
        meta: null,
        google: { label: 'Philip Antonetti', expiresAt: null, expired: false },
      },
    })
    expect(screen.getByText(/Google: connected as Philip Antonetti/)).toBeTruthy()
    expect(screen.queryByText(/Renew by/)).toBeNull()
  })

  // Two lines of "not connected" would be noise: the button says what to do and
  // the empty table says it too.
  it('says nothing at all when neither platform is connected', () => {
    renderPage([])
    expect(screen.queryByText(/connected as/)).toBeNull()
    expect(screen.getByText(/Nothing connected yet/)).toBeTruthy()
  })
})

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

  // Two tests lived here, each asserting one of the two hrefs the test above
  // already asserts together with the same renderPage([]) / default-ready
  // setup: 'links the Google connect button straight to the oauth start when
  // ready' and 'links Connect with Facebook straight to the oauth start when
  // ready'. 'offers both connect buttons as real links…' above subsumes both
  // exactly, so keeping them proved nothing a break in that test would not
  // already catch.

  // The client pressed this control eight times on the live site and collected
  // eight identical red toasts. It was an enabled <button> wearing the same
  // class as the working "Sync now" beside it, so nothing about it read as
  // unavailable, and its only answer was transient and phrased as a fact about
  // our server. Pressing again was the only move the page left him.
  it('shows an unavailable platform as disabled instead of a button that argues back', () => {
    renderPage([], { platform: { meta: false, google: true } })

    const facebook = screen.getByText('Connect with Facebook').closest('button')
    expect(facebook).toBeTruthy()
    expect(facebook!.disabled).toBe(true)
    // Google is unaffected and still a real link.
    expect(screen.getByText('Connect with Google').closest('a')).toBeTruthy()
  })

  it('says on the page, and keeps saying, that the platform needs nothing from the reader', () => {
    renderPage([], { platform: { meta: true, google: false } })

    // Present with no click at all: the old toast only appeared once pressed,
    // and vanished, which is why pressing again looked like the way forward.
    expect(
      screen.getByText('Google: not connected yet. Setup is on our side, nothing to do here.'),
    ).toBeTruthy()
    // Names the platform actually missing, not a hardcoded "Facebook".
    expect(screen.queryByText(/^Facebook: not connected yet/)).toBeNull()
    expect(screen.getByText('Connect with Facebook').closest('a')).toBeTruthy()
  })

  it('does not stack a new message every time the dead control is pressed', () => {
    renderPage([], { platform: { meta: true, google: false } })

    const google = screen.getByText('Connect with Google')
    fireEvent.click(google)
    fireEvent.click(google)
    fireEvent.click(google)

    expect(
      screen.getAllByText('Google: not connected yet. Setup is on our side, nothing to do here.'),
    ).toHaveLength(1)
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
  // no test - it reads as coverage while proving nothing.
})
