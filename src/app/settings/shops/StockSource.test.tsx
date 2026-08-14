// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ShopsClient, type Row } from './ShopsClient'
import { ToastProvider } from '@/components/toast/ToastProvider'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/shops',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

afterEach(() => vi.unstubAllGlobals())

const shop = (over: Partial<Row> & { id: string; name: string }): Row => ({
  currency: 'NOK', wooUrl: '', connected: true, lastSyncAt: null,
  hasOrders: false, lastRunAt: null, lastError: null, stockSource: false,
  ...over,
})

const NORWAY = shop({ id: 's1', name: 'Panetti Norway', stockSource: true })
const FINLAND = shop({ id: 's2', name: 'Panetti Finland' })

function renderShops(shops: Row[] = [NORWAY, FINLAND]) {
  return render(
    <ToastProvider>
      <ShopsClient email="admin@test.local" shops={shops} />
    </ToastProvider>,
  )
}

/** The stock-source checkbox belonging to one shop's row. */
const boxFor = (name: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`stock.*${name}|${name}.*stock`, 'i') })

describe('choosing which shops report the stock', () => {
  it('shows which shops are already the source', () => {
    renderShops()
    expect((boxFor('Panetti Norway') as HTMLInputElement).checked).toBe(true)
    expect((boxFor('Panetti Finland') as HTMLInputElement).checked).toBe(false)
  })

  it('turns a shop into a stock source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderShops()

    fireEvent.click(boxFor('Panetti Finland'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/shops/s2')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ stockSource: true })
  })

  it('turns one off again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderShops()

    fireEvent.click(boxFor('Panetti Norway'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      stockSource: false,
    })
  })

  /**
   * The checkbox must never send the Woo credentials. The PATCH route treats a
   * blank key as "keep what is saved", so a body carrying empty strings would be
   * harmless today — but a body carrying the SHOP'S OWN wooUrl would rewrite it,
   * and ticking a box has no business touching a store connection.
   */
  it('sends nothing but the flag, so a tick cannot disturb the connection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderShops()

    fireEvent.click(boxFor('Panetti Finland'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(Object.keys(body)).toEqual(['stockSource'])
  })

  it('says so when the save fails, and puts the tick back', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Could not save' }), { status: 500 }),
    ))
    renderShops()

    fireEvent.click(boxFor('Panetti Finland'))

    // A tick that silently did not save is the worst outcome: the forecast would
    // go on using a shop the operator believes they turned off.
    await waitFor(() =>
      expect((boxFor('Panetti Finland') as HTMLInputElement).checked).toBe(false),
    )
  })

  it('explains what the column is for', () => {
    renderShops()
    expect(document.body.textContent).toMatch(/stock/i)
  })
})
