// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { Chat } from './Chat'

// jsdom has no layout, so this method does not exist there.
const scrollIntoViewMock = vi.fn()
Element.prototype.scrollIntoView = scrollIntoViewMock

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  // localStorage now outlives a test the way it outlives a tab, so a leak
  // here would let one test's conversation appear in the next one.
  window.localStorage.clear()
  // The mock is assigned once at module scope, so call counts would
  // otherwise accumulate across every test in this file.
  scrollIntoViewMock.mockClear()
})

function stubFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Chat', () => {
  it('shows the question and then the answer', async () => {
    const fetchMock = stubFetch({ reply: 'Sweden fell because advertising efficiency dropped.', messages: [] })
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Why was Sweden down?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(screen.getByText('Why was Sweden down?')).toBeInTheDocument()
    // The exact contract Task 10's route depends on: a fresh mount's
    // transcript is empty, so this first call must carry only the one new
    // turn -- a wrong field name or a dropped transcript would leave every
    // bubble-level assertion in this file green while breaking the route.
    expect(fetchMock).toHaveBeenCalledWith('/api/advisor/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Why was Sweden down?' }] }),
    })
    await waitFor(() =>
      expect(screen.getByText(/advertising efficiency dropped/)).toBeInTheDocument(),
    )
  })

  it('shows the reason plainly when the server refuses', async () => {
    stubFetch({ error: 'No ANTHROPIC_API_KEY is configured, so the advisor cannot answer.' }, false)
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument())
  })

  it('does not send an empty question', () => {
    const fetchMock = stubFetch({ reply: '' })
    render(<Chat />)
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('survives a refresh by restoring the conversation', async () => {
    stubFetch({ reply: 'Answer one.', messages: [] })
    const { unmount } = render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Question one' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(screen.getByText('Answer one.')).toBeInTheDocument())

    unmount()
    render(<Chat />)
    expect(screen.getByText('Question one')).toBeInTheDocument()
    expect(screen.getByText('Answer one.')).toBeInTheDocument()
  })

  it('offers example questions on an empty chat, and asking one sends it', async () => {
    // An empty box with a placeholder shows the control but not the capability:
    // nothing tells the reader this can compare two weeks or name a product.
    const fetchMock = stubFetch({ reply: 'Because ad efficiency fell.', messages: [] })
    render(<Chat />)

    const example = screen.getAllByRole('button', { name: /why/i })[0]
    fireEvent.click(example)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content).toBe(example.textContent)
  })

  it('hides the examples once the conversation has started', async () => {
    stubFetch({ reply: 'Answered.', messages: [] })
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'My own question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^Why did/i })).not.toBeInTheDocument()
  })

  function seed(day: string | null, text: string) {
    window.localStorage.setItem(
      'advisor-chat',
      JSON.stringify({ day, bubbles: [{ role: 'user', text }], transcript: [] }),
    )
  }

  it('restores a conversation stored under the same day', () => {
    seed('2026-08-13', 'question from this morning')
    render(<Chat day="2026-08-13" />)
    expect(screen.getByText('question from this morning')).toBeInTheDocument()
  })

  it('starts empty when the stored conversation belongs to another day', () => {
    seed('2026-08-12', 'question from yesterday')
    render(<Chat day="2026-08-13" />)
    expect(screen.queryByText('question from yesterday')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('advisor-chat')).toBeNull()
  })

  // A briefing that failed to load must not destroy the conversation.
  it('keeps the conversation when no day is known yet', () => {
    seed('2026-08-12', 'question from yesterday')
    render(<Chat />)
    expect(screen.getByText('question from yesterday')).toBeInTheDocument()
  })

  it('keeps an unstamped conversation once a day arrives', () => {
    seed(null, 'asked before the briefing loaded')
    render(<Chat day="2026-08-13" />)
    expect(screen.getByText('asked before the briefing loaded')).toBeInTheDocument()
  })

  it('stamps what it saves with the current day', async () => {
    stubFetch({ reply: 'Answered.', messages: [] })
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())
    const stored = JSON.parse(window.localStorage.getItem('advisor-chat') as string)
    expect(stored.day).toBe('2026-08-13')
    expect(stored.bubbles).toHaveLength(2)
  })

  it('shows no conversation card until something has been asked', () => {
    render(<Chat />)
    expect(screen.queryByRole('heading', { name: 'Ask' })).not.toBeInTheDocument()
    // The composer is always there, though.
    expect(screen.getByPlaceholderText(/Ask/i)).toBeInTheDocument()
  })

  it('offers no way to clear an empty conversation', () => {
    render(<Chat />)
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
  })

  it('clears the conversation and the stored copy', async () => {
    stubFetch({ reply: 'Answered.', messages: [{ role: 'user', content: 'A question' }] })
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /clear/i }))

    expect(screen.queryByText('A question')).not.toBeInTheDocument()
    expect(screen.queryByText('Answered.')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('advisor-chat')).toBeNull()
    // And the examples come back, because the box is empty again.
    expect(screen.getAllByRole('button', { name: /why/i })[0]).toBeInTheDocument()
  })

  it('cannot be cleared while an answer is in flight', async () => {
    // A fetch that never settles leaves the component busy.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})))
    render(<Chat day="2026-08-13" />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText(/Looking it up/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /clear/i })).toBeDisabled()
  })

  it('scrolls without animation when the visitor prefers reduced motion', async () => {
    stubFetch({ reply: 'Answered.', messages: [] })
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
  })

  it('scrolls smoothly when reduced motion is not requested', async () => {
    // jsdom has no matchMedia at all, which the guard treats the same as a
    // browser reporting no preference: the default, animated path.
    stubFetch({ reply: 'Answered.', messages: [] })
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'A question' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(screen.getByText('Answered.')).toBeInTheDocument())
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' })
  })
})
