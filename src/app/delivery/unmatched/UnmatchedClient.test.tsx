// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@/components/toast/ToastProvider'
import type { UnlinkedParcel } from '../DeliveryClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/delivery/unmatched',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const { UnmatchedClient } = await import('./UnmatchedClient')

afterEach(() => vi.unstubAllGlobals())

const LIST = '/api/delivery?preset=this_month'

const parcel: UnlinkedParcel = {
  trackingNumber: '473325380023179098', carrier: 'DHL',
  url: 'https://www.dhl.com/se-en/home/tracking.html?tracking-id=473325380023179098',
  lastStatus: 'DELIVERED', destinationCountry: 'DE', bookedAt: '2026-09-07T17:30:00.000Z', weightKg: 18.2,
  recipientName: 'Tobias Kohlmeyer', reason: 'DHL parcel to DE: DHL gives no name or email, so no order could be matched by itself',
  identifiedAt: '2026-09-08T00:15:00.000Z', createdAt: '2026-09-07T16:00:00.000Z',
  candidates: [
    { orderId: 'o-15864', number: '15864', shop: 'Panetti Germany', customerName: 'Tobias Kohlmeyer', placedAt: '2026-09-07T15:49:00.000Z', items: '1 x Panetti ProMix', holdsParcel: false, sameName: true },
  ],
  candidatesTotal: 1,
}
const payload = () => ({ unlinked: [parcel], unlinkedTotal: 1, shops: [{ id: 's-de', name: 'Panetti Germany' }] })
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response

const draw = () =>
  render(
    <ToastProvider>
      <UnmatchedClient email="ops@ecom.test" role="OPERATIONS" />
    </ToastProvider>,
  )

describe('UnmatchedClient', () => {
  it('is the Unmatched parcels tab, with the list open on arrival and nothing to press first', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => reply(payload()))
    vi.stubGlobal('fetch', fetchMock)
    draw()

    // The row's facts are on screen without opening anything.
    expect(await screen.findByText('18.2 kg')).toBeInTheDocument()
    expect(screen.getByText('Tobias Kohlmeyer', { exact: true })).toBeInTheDocument()

    const tabs = within(screen.getByRole('navigation', { name: 'Section' }))
    expect(tabs.getByRole('link', { name: 'Unmatched parcels' })).toHaveAttribute('aria-current', 'page')
    expect(tabs.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/delivery')
    expect(tabs.getByRole('link', { name: 'Recent imports' })).toHaveAttribute('href', '/delivery/imports')
    expect(fetchMock.mock.calls[0][0]).toBe(LIST)
  })

  it('asks for the list again once a parcel is dismissed, so what is left is what shows', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) =>
      init?.method === 'PATCH' ? reply({}) : reply(payload()),
    )
    vi.stubGlobal('fetch', fetchMock)
    draw()

    fireEvent.click(await screen.findByRole('button', { name: 'Not a customer parcel' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === LIST)).toHaveLength(2))
  })

  it('says when the list could not be loaded, instead of an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: 'Not signed in' }, false)))
    draw()
    expect(await screen.findByText('Not signed in')).toBeInTheDocument()
  })
})
