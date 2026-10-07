// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { WebhooksClient, type Webhook } from './WebhooksClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/shops/s1/webhooks',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

afterEach(() => vi.unstubAllGlobals())

const MACO: Webhook = {
  id: 125,
  name: 'Maco Core Order Created',
  topic: 'order.created',
  status: 'disabled',
  delivery: 'ledende-teknologi-panetti.core.maco.io/api/operations/staging/order-sync',
  ours: false,
  created: '2026-05-13T06:25:09',
  modified: '2026-08-03T06:59:54',
}
const OURS: Webhook = {
  id: 9,
  name: 'panetti-analytics order.updated',
  topic: 'order.updated',
  status: 'active',
  delivery: 'panetti.vercel.app/api/webhooks/woo/s1',
  ours: true,
  created: '2026-08-01T00:00:00',
  modified: '2026-08-01T00:00:00',
}

function renderPage(webhooks: Webhook[] = [MACO, OURS], error: string | null = null) {
  return render(
    <ToastProvider>
      <WebhooksClient
        email="admin@test.local"
        shop={{ id: 's1', name: 'Panetti Norway' }}
        webhooks={webhooks}
        error={error}
      />
    </ToastProvider>,
  )
}

describe('WebhooksClient', () => {
  it('shows every webhook with its status in plain words, and marks ours', () => {
    renderPage()
    const maco = screen.getByText('Maco Core Order Created').closest('tr')!
    expect(within(maco).getByText('Off')).toBeTruthy()
    expect(within(maco).getByText('New order')).toBeTruthy()
    expect(within(maco).getByText(/core\.maco\.io/)).toBeTruthy()

    const ours = screen.getByText('panetti-analytics order.updated').closest('tr')!
    expect(within(ours).getByText('On')).toBeTruthy()
    expect(within(ours).getByText('this app')).toBeTruthy()
  })

  it('offers Switch on only on a webhook that is off', () => {
    renderPage()
    const buttons = screen.getAllByRole('button', { name: /Switch on/ })
    expect(buttons).toHaveLength(1)
    expect(buttons[0].closest('tr')!.textContent).toContain('Maco Core Order Created')
  })

  /**
   * The row must end up showing what the STORE reports after the switch, not
   * what we asked for: a store that silently refuses would otherwise read "On".
   */
  it('switches a webhook on, then shows the status the store reports', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ before: 'disabled', after: 'active' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ shops: [{ shop: 'Panetti Norway', ok: true, webhooks: [{ ...MACO, status: 'active' }, OURS] }] }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /Switch on/ }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Switch on/ })).toBeNull()
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/diagnostics/woo-webhooks/enable')
    expect(JSON.parse(init.body)).toEqual({ shopId: 's1', webhookId: 125 })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/diagnostics/woo-webhooks?shopId=s1')
    const maco = screen.getByText('Maco Core Order Created').closest('tr')!
    expect(within(maco).getByText('On')).toBeTruthy()
  })

  it("shows the store's own words when switching on fails, and keeps the button", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'WooCommerce responded 401' }), { status: 500 })),
    )
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: /Switch on/ }))

    await waitFor(() => {
      expect(screen.getByText('WooCommerce responded 401')).toBeTruthy()
    })
    expect(screen.getByRole('button', { name: /Switch on/ })).toBeTruthy()
  })

  it('says so when the store could not be read, instead of an empty table', () => {
    renderPage([], 'WooCommerce responded 401')
    expect(screen.getByText(/could not read/i)).toBeTruthy()
    expect(screen.getByText('WooCommerce responded 401')).toBeTruthy()
  })

  it('explains that switching on helps new orders only', () => {
    renderPage()
    expect(screen.getByText(/5 failed deliveries/)).toBeTruthy()
    expect(screen.getByText(/new orders only/)).toBeTruthy()
  })
})
