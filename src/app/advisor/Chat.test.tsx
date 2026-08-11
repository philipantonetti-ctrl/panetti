// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { Chat } from './Chat'

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
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
})
