// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ToastProvider } from '@/components/toast/ToastProvider'
import { SandboxClient } from './SandboxClient'

/**
 * The practice room, driven the way an admin drives it.
 *
 * The plan asked for this screen to be opened in a browser and talked to. A
 * dev server will not start inside this worktree, so the same journey is
 * proved here instead - and unlike a look, it stays: what the page SENDS
 * (the whole transcript, every turn) is the half a screenshot cannot check.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/support/sandbox',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

// jsdom implements no scrolling at all, and the page scrolls itself to the
// newest line after every turn. Test-environment gap, not component code.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => vi.unstubAllGlobals())

const SHOPS = [
  { id: 's-no', name: 'Panetti Norway' },
  { id: 's-dk', name: 'Panetti Denmark' },
]

const result = (over = {}) => ({
  conversationId: 'c1',
  reply: 'Din pakke er på vej.',
  action: 'send',
  reason: null,
  category: 'shipping',
  language: 'da',
  confidence: 0.95,
  knowledge: [{ kind: 'policy', title: 'Levering' }],
  saw: {
    customer: 'Mette (mette@example.com)',
    orders: [{ number: '14689', shop: 'Panetti Denmark', status: 'completed', delivery: 'in transit', parcels: ['733253836'] }],
  },
  ...over,
})

/** Records every call so a test can assert what actually went over the wire. */
function mockFetch(turn: { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/api/support/knowledge')) {
        return new Response(JSON.stringify({ shops: SHOPS, items: [] }), { status: 200 })
      }
      if (url.includes('/api/support/sandbox')) {
        return new Response(JSON.stringify(turn.body), { status: turn.status ?? 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
  return calls
}

const draw = () => render(<ToastProvider><SandboxClient email="admin@test.local" /></ToastProvider>)

async function say(text: string) {
  fireEvent.change(screen.getByLabelText('Message as the customer'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('the assistant sandbox', () => {
  it('opens on the Danish shop, which is the one the assistant answers first', async () => {
    mockFetch({ body: result() })
    draw()

    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))
  })

  it('sends the whole conversation, not just the newest line', async () => {
    const calls = mockFetch({ body: result() })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Hvor er min pakke?')
    await screen.findByText('Din pakke er på vej.')

    await say('Hvornår kommer den?')
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/support/sandbox'))).toHaveLength(2))

    const second = JSON.parse(calls.filter((c) => c.url.includes('/api/support/sandbox'))[1].init!.body as string)
    expect(second.shopId).toBe('s-dk')
    // The judge cannot answer "when" without the turn before it.
    expect(second.messages).toEqual([
      { role: 'user', text: 'Hvor er min pakke?' },
      { role: 'assistant', text: 'Din pakke er på vej.' },
      { role: 'user', text: 'Hvornår kommer den?' },
    ])
  })

  it('says what it WOULD have done, and what it looked at', async () => {
    mockFetch({ body: result() })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Hvor er min pakke?')

    expect(await screen.findByText('Would send this')).toBeInTheDocument()
    expect(screen.getByText(/95% sure/)).toBeInTheDocument()
    expect(screen.getByText(/policy: Levering/)).toBeInTheDocument()
    // The right-hand panel: the facts it had in front of it.
    expect(screen.getByText(/Mette \(mette@example.com\)/)).toBeInTheDocument()
    expect(screen.getByText(/14689/)).toBeInTheDocument()
  })

  it('names a handover rather than dressing it up as an answer', async () => {
    mockFetch({ body: result({ action: 'escalate', reason: 'the customer asked for a person' }) })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Jeg vil tale med et menneske')

    expect(await screen.findByText('Would hand over to a person')).toBeInTheDocument()
    expect(screen.getByText(/because the customer asked for a person/)).toBeInTheDocument()
  })

  /** A refusal from the route is the only thing that tells an admin why. */
  it('shows the sandbox’s own words when a turn cannot run', async () => {
    mockFetch({ status: 400, body: { error: 'No ANTHROPIC_API_KEY is configured, so the assistant cannot read tickets.' } })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Hvor er min pakke?')

    expect(await screen.findByText(/No ANTHROPIC_API_KEY is configured/)).toBeInTheDocument()
    expect(screen.queryByText('Would send this')).toBeNull()
  })

  it('saves a correction against the conversation it belongs to', async () => {
    const calls = mockFetch({ body: result() })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Hvor er min pakke?')
    await screen.findByText('Would send this')

    fireEvent.click(screen.getByRole('button', { name: 'Wrong' }))
    fireEvent.change(screen.getByLabelText('What it should have said'), {
      target: { value: 'Den er afsendt i dag og kommer i morgen.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))

    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/support/conversations/c1'))).toBe(true))
    const patch = calls.find((c) => c.url.includes('/api/support/conversations/c1'))!
    expect(patch.init?.method).toBe('PATCH')
    expect(JSON.parse(patch.init!.body as string)).toEqual({
      rating: 'bad',
      correction: 'Den er afsendt i dag og kommer i morgen.',
    })
  })

  it('starts a new session when the shop changes, so two shops never share a transcript', async () => {
    const calls = mockFetch({ body: result() })
    draw()
    await waitFor(() => expect(screen.getByLabelText('Shop')).toHaveValue('s-dk'))

    await say('Hvor er min pakke?')
    await screen.findByText('Din pakke er på vej.')
    const first = JSON.parse(calls.filter((c) => c.url.includes('/api/support/sandbox'))[0].init!.body as string)

    fireEvent.change(screen.getByLabelText('Shop'), { target: { value: 's-no' } })
    expect(screen.queryByText('Din pakke er på vej.')).toBeNull()

    await say('Hvor er pakken min?')
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/support/sandbox'))).toHaveLength(2))

    const second = JSON.parse(calls.filter((c) => c.url.includes('/api/support/sandbox'))[1].init!.body as string)
    expect(second.shopId).toBe('s-no')
    expect(second.sessionKey).not.toBe(first.sessionKey)
    expect(second.messages).toHaveLength(1)
  })
})
