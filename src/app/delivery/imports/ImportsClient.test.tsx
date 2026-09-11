// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ImportRow } from '../DeliveryClient'

vi.mock('next/navigation', () => ({
  usePathname: () => '/delivery/imports',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const { ImportsClient } = await import('./ImportsClient')

afterEach(() => vi.unstubAllGlobals())

const LIST = '/api/delivery?preset=this_month'

const row: ImportRow = {
  id: 'i1', filename: 'eod.xlsx', receivedAt: '2026-09-11T16:05:00.000Z',
  rowsParsed: 64, rowsLinked: 60, rowsUnmatched: 4, namesRead: 64, error: null,
  source: 'EMAIL', unmatched: null, rereadAt: null, rereadLinked: null,
}
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response

const draw = () => render(<ImportsClient email="ops@ecom.test" role="OPERATIONS" />)

describe('ImportsClient', () => {
  it('is the Recent imports tab: the box to send a file, above every file read', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => reply({ imports: [row] }))
    vi.stubGlobal('fetch', fetchMock)
    draw()

    expect(await screen.findByText('eod.xlsx')).toBeInTheDocument()
    expect(screen.getByText('Tracking file from the warehouse')).toBeInTheDocument()

    const tabs = within(screen.getByRole('navigation', { name: 'Section' }))
    expect(tabs.getByRole('link', { name: 'Recent imports' })).toHaveAttribute('aria-current', 'page')
    expect(tabs.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/delivery')
    expect(tabs.getByRole('link', { name: 'Unmatched parcels' })).toHaveAttribute('href', '/delivery/unmatched')
    expect(fetchMock.mock.calls[0][0]).toBe(LIST)
  })

  it('asks for the list again after a file is sent, so the file just sent appears below the box', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) =>
      init?.method === 'POST'
        ? reply({ parsed: 3, linked: 3, unmatched: [], unaccounted: 0 })
        : reply({ imports: [row] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    draw()
    await screen.findByText('eod.xlsx')

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'eod-2.xlsx')] } })

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === LIST)).toHaveLength(2))
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/delivery/import' && init?.method === 'POST')).toBe(true)
  })
})
