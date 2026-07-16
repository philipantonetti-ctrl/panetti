// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { ToastProvider } from './ToastProvider'
import { useToast } from './useToast'

afterEach(() => vi.useRealTimers())

function Buttons() {
  const toast = useToast()
  return (
    <>
      <button onClick={() => toast.success('Saved.')}>ok</button>
      <button onClick={() => toast.error('It broke.')}>bad</button>
      <button onClick={() => toast.error('Also broke.')}>bad2</button>
    </>
  )
}

const setup = () => render(<ToastProvider><Buttons /></ToastProvider>)

describe('ToastProvider', () => {
  it('shows a success toast when asked', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    expect(screen.getByText('Saved.')).toBeDefined()
  })

  it('dismisses a success toast after 4 seconds, and not before', async () => {
    vi.useFakeTimers()
    setup()
    fireEvent.click(screen.getByText('ok'))

    await act(async () => { vi.advanceTimersByTime(3999) })
    expect(screen.queryByText('Saved.')).not.toBeNull()

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  // Errors carry the server's own wording and are long. 4s is not a read.
  it('keeps an error toast for 10 seconds, not 4', async () => {
    vi.useFakeTimers()
    setup()
    fireEvent.click(screen.getByText('bad'))

    await act(async () => { vi.advanceTimersByTime(4000) })
    expect(screen.queryByText('It broke.')).not.toBeNull() // a success would be gone

    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(screen.queryByText('It broke.')).toBeNull()
  })

  it('stacks two toasts rather than replacing the first', () => {
    setup()
    fireEvent.click(screen.getByText('bad'))
    fireEvent.click(screen.getByText('bad2'))
    expect(screen.queryByText('It broke.')).not.toBeNull()
    expect(screen.queryByText('Also broke.')).not.toBeNull()
  })

  it('dismisses when clicked, without waiting for the timer', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    fireEvent.click(screen.getByText('Saved.'))
    expect(screen.queryByText('Saved.')).toBeNull()
  })

  it('announces politely to screen readers', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    const region = screen.getByRole('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
  })

  // Must clear the modal layer, which sits at z-50.
  it('renders above the modal layer', () => {
    setup()
    fireEvent.click(screen.getByText('ok'))
    expect(screen.getByRole('status').style.zIndex).toBe('var(--z-toast)')
  })

  // A missing provider must fail loudly in dev, never swallow messages.
  it('throws if used outside a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Buttons />)).toThrow(/ToastProvider/)
    quiet.mockRestore()
  })
})
