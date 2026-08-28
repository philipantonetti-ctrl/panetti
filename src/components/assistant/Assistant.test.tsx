// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Assistant } from './Assistant'

let path = '/inventory'
vi.mock('next/navigation', () => ({ usePathname: () => path }))

// jsdom implements no scrolling, and the panel scrolls itself to the newest
// message. Same stub the Advisor's chat test used.
Element.prototype.scrollIntoView = vi.fn()

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const replies = (reply: string) =>
  vi.fn<Fetch>(async () => new Response(JSON.stringify({ reply, messages: [] }), { status: 200 }))

beforeEach(() => {
  path = '/inventory'
  window.localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

const open = () => fireEvent.click(screen.getByRole('button', { name: /ask the assistant/i }))

describe('Assistant', () => {
  it('is a button until it is wanted, so it never covers the page', () => {
    render(<Assistant />)
    expect(screen.getByRole('button', { name: /ask the assistant/i })).toBeInTheDocument()
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument()
  })

  it('opens, and closes again', () => {
    render(<Assistant />)
    open()
    expect(screen.getByLabelText('Your question')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /close the assistant/i }))
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument()
  })

  /**
   * The client's own example: standing on the forecast, asking "how did you
   * calculate that". The page has to travel with the question or "that" means
   * nothing.
   */
  it('tells the server which page the question was asked from', async () => {
    const fetchMock = replies('Because it runs out on 1 October.')
    vi.stubGlobal('fetch', fetchMock)
    render(<Assistant />)
    open()

    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'how did you calculate that?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.page).toBe('/inventory')
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'how did you calculate that?' })

    expect(await screen.findByText('Because it runs out on 1 October.')).toBeInTheDocument()
  })

  it('shows the question straight away, and says what it is doing', async () => {
    vi.stubGlobal('fetch', vi.fn<Fetch>(() => new Promise(() => {})))
    render(<Assistant />)
    open()
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('why?')).toBeInTheDocument()
    expect(screen.getByText(/looking it up/i)).toBeInTheDocument()
  })

  it("passes on the server's own reason when it cannot answer", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async () => new Response(JSON.stringify({ error: 'No ANTHROPIC_API_KEY is configured.' }), { status: 503 })),
    )
    render(<Assistant />)
    open()
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(/No ANTHROPIC_API_KEY is configured\./)).toBeInTheDocument()
  })

  it('keeps the conversation across pages, and clears it on request', async () => {
    vi.stubGlobal('fetch', replies('Norway.'))
    const first = render(<Assistant />)
    open()
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'which shop?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Norway.')
    first.unmount()

    // Walked to another page: same conversation, still there.
    path = '/dashboard'
    render(<Assistant />)
    open()
    expect(await screen.findByText('Norway.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('Norway.')).not.toBeInTheDocument()
  })

  it('will not send an empty question', () => {
    const fetchMock = replies('x')
    vi.stubGlobal('fetch', fetchMock)
    render(<Assistant />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
