// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { CampaignsModal } from './CampaignsModal'

// NOTE: this repo does NOT have @testing-library/user-event installed. Every
// existing DOM test drives the UI with fireEvent (see B2bClient.test.tsx).
// Do not add the dependency for this.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SHOPS = [
  { id: 's1', name: 'Panetti Norway' },
  { id: 's2', name: 'Panetti Sweden' },
]

const payload = {
  splitByCampaign: true,
  defaultShopId: 's1',
  campaigns: [
    { id: 'a', externalId: 'c1', name: 'Norway Brand', shopId: 's1' },
    { id: 'b', externalId: 'c2', name: 'Sweden Brand', shopId: null },
  ],
}

function stubFetch(saved: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        saved.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(payload), { status: 200 })
    }),
  )
}

describe('CampaignsModal', () => {
  it('lists every campaign with its current store', async () => {
    stubFetch()
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByText('Norway Brand')).toBeTruthy()
    expect(screen.getByText('Sweden Brand')).toBeTruthy()
  })

  it('shows an unassigned campaign as using the account store', async () => {
    stubFetch()
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    expect(select.value).toBe('') // '' is the "Use the account's store" option
  })

  it('saves the assignments that were changed', async () => {
    const saved: unknown[] = []
    stubFetch(saved)
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 's2' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({
      assignments: expect.arrayContaining([{ campaignId: 'b', shopId: 's2' }]),
    })
  })

  it('says so when the account has no campaigns yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ splitByCampaign: false, defaultShopId: 's1', campaigns: [] }), { status: 200 }),
    ))
    render(<CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />)

    expect(await screen.findByText(/no campaigns yet/i)).toBeTruthy()
  })
})
