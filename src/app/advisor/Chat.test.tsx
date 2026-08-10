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
    stubFetch({ reply: 'Sweden fell because advertising efficiency dropped.', messages: [] })
    render(<Chat />)

    fireEvent.change(screen.getByPlaceholderText(/Ask/i), { target: { value: 'Why was Sweden down?' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(screen.getByText('Why was Sweden down?')).toBeInTheDocument()
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
})
