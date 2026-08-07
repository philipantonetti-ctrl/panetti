// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { CampaignsModal } from './CampaignsModal'

// NOTE: this repo does NOT have @testing-library/user-event installed. Every
// existing DOM test drives the UI with fireEvent (see B2bClient.test.tsx).
// Do not add the dependency for this.

// CampaignsModal uses the throwing useToast() hook on its save path, like
// AccountModal and PickerModal beside it, so every render needs a real
// ToastProvider ancestor — matching CustomerModal.test.tsx's own helper.
function renderWithToast(ui: ReactNode) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

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
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />,
    )

    expect(await screen.findByText('Norway Brand')).toBeTruthy()
    expect(screen.getByText('Sweden Brand')).toBeTruthy()
  })

  it('shows an unassigned campaign as using the account store', async () => {
    stubFetch()
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />,
    )

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    expect(select.value).toBe('') // '' is the "Use the account's store" option
  })

  // FINDING 1: a component that ignores `c.shopId` entirely (defaults every
  // select to '') would still pass the previous two tests, since the first
  // option's own value is '' and an uncontrolled select reads that anyway.
  // Asserting the ASSIGNED campaign's select too closes that gap: it only
  // reads 's1' if the component actually reads `c.shopId` off the payload.
  it('shows an assigned campaign selecting its current store', async () => {
    stubFetch()
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />,
    )

    const select = (await screen.findByLabelText('Store for Norway Brand')) as HTMLSelectElement
    expect(select.value).toBe('s1')
  })

  it('saves the assignments that were changed', async () => {
    const saved: unknown[] = []
    stubFetch(saved)
    const onSaved = vi.fn()
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={onSaved} />,
    )

    const select = (await screen.findByLabelText('Store for Sweden Brand')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 's2' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({
      assignments: expect.arrayContaining([{ campaignId: 'b', shopId: 's2' }]),
    })
    // FINDING 3: onSaved is the only externally observable "the save actually
    // finished" signal here — a save that silently swallowed a successful
    // response would still leave every earlier assertion green.
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  // FINDING 2: every other save test only exercises a real-id passthrough
  // ('' -> 's2'). The '' -> null mapping is the highest-risk path in this
  // component: the API's assignments schema is `z.string().min(1).nullable()`,
  // so if this regressed and sent '' instead of null, every save touching an
  // unassigned campaign would 400 — which is nearly every real save. Assert
  // `null` explicitly; a loose "not 's1'" check would let '' through.
  it('sends null when a campaign is unassigned back to the account store', async () => {
    const saved: unknown[] = []
    stubFetch(saved)
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />,
    )

    const select = (await screen.findByLabelText('Store for Norway Brand')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toMatchObject({
      assignments: expect.arrayContaining([{ campaignId: 'a', shopId: null }]),
    })
  })

  it('says so when the account has no campaigns yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ splitByCampaign: false, defaultShopId: 's1', campaigns: [] }), { status: 200 }),
    ))
    renderWithToast(
      <CampaignsModal accountId="acct" shops={SHOPS} onClose={() => {}} onSaved={() => {}} />,
    )

    expect(await screen.findByText(/no campaigns yet/i)).toBeTruthy()
  })
})
