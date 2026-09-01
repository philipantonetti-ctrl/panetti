// @vitest-environment jsdom
import type { ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/payouts',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { DinteroClient } = await import('./DinteroClient')

function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const shop = (over: Record<string, unknown> = {}) => ({
  shopId: 'sh1',
  name: 'Panetti Norway',
  currency: 'NOK',
  connected: false,
  accountId: null,
  payoutDestinationId: null,
  lastSyncAt: null,
  lastError: null,
  payouts: 0,
  ...over,
})

const statusResponse = (shops: unknown[]) => new Response(JSON.stringify({ shops }), { status: 200 })

describe('DinteroClient', () => {
  it('shows one card per shop, waiting or connected with its figures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          statusResponse([
            shop(),
            shop({
              shopId: 'sh2', name: 'Panetti Sweden', currency: 'SEK', connected: true,
              accountId: 'P87654321', payouts: 52, lastSyncAt: '2026-09-01T06:00:00Z',
            }),
          ]),
        ),
      ),
    )
    renderWithToast(<DinteroClient email="a@b.test" />)

    expect(await screen.findByText('Not connected.')).toBeInTheDocument()
    expect(screen.getByText(/P87654321/)).toBeInTheDocument()
    expect(screen.getByText(/52 payouts imported/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })

  it('sends the pasted credentials for the right shop and reports the import', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ shops: [shop({ connected: true })], sync: { ok: true, payouts: 12 } }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(statusResponse([shop()]))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithToast(<DinteroClient email="a@b.test" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Account ID for Panetti Norway'), { target: { value: 'P12345678' } })
    fireEvent.change(screen.getByLabelText('Client ID for Panetti Norway'), { target: { value: 'cid-1234' } })
    fireEvent.change(screen.getByLabelText('Client Secret for Panetti Norway'), { target: { value: 'sec-1234' } })
    // Two Connect buttons now: the card toggle turned into Close, so the
    // remaining one is the form's submit.
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      expect(post).toBeTruthy()
      expect(JSON.parse((post![1] as RequestInit).body as string)).toMatchObject({
        shopId: 'sh1',
        accountId: 'P12345678',
        clientId: 'cid-1234',
        clientSecret: 'sec-1234',
      })
    })
    expect(await screen.findByText(/12 payouts imported/)).toBeInTheDocument()
  })

  it('refuses to send until the account id looks like an account id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(statusResponse([shop()]))))
    renderWithToast(<DinteroClient email="a@b.test" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    fireEvent.change(screen.getByLabelText('Account ID for Panetti Norway'), { target: { value: 'nope' } })
    fireEvent.change(screen.getByLabelText('Client ID for Panetti Norway'), { target: { value: 'cid-1234' } })
    fireEvent.change(screen.getByLabelText('Client Secret for Panetti Norway'), { target: { value: 'sec-1234' } })

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })
})
