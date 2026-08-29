// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, fireEvent } from '@testing-library/react'
import { useLiveTick } from './use-live-tick'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  // Undo any document.hidden override a test installed.
  delete (document as unknown as Record<string, unknown>).hidden
})

/** jsdom's document.hidden is read-only; shadow it per test. */
function hideTab(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

describe('useLiveTick', () => {
  it('ticks on the interval while the tab is visible', () => {
    const { result } = renderHook(() => useLiveTick(60_000))
    expect(result.current).toBe(0)

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(1)

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(2)
  })

  it('ticks when the window regains focus', () => {
    const { result } = renderHook(() => useLiveTick(60_000))

    act(() => vi.advanceTimersByTime(1_500))
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    expect(result.current).toBe(1)
  })

  it('collapses focus and visibilitychange firing together into one tick', () => {
    const { result } = renderHook(() => useLiveTick(60_000))

    act(() => vi.advanceTimersByTime(1_500))
    act(() => {
      fireEvent(window, new Event('focus'))
      fireEvent(document, new Event('visibilitychange'))
    })
    expect(result.current).toBe(1)
  })

  it('swallows a focus event racing the first render - the mount already fetched', () => {
    const { result } = renderHook(() => useLiveTick(60_000))

    act(() => {
      fireEvent(window, new Event('focus'))
    })
    expect(result.current).toBe(0)
  })

  it('never ticks while the tab is hidden', () => {
    hideTab(true)
    const { result } = renderHook(() => useLiveTick(60_000))

    act(() => vi.advanceTimersByTime(180_000))
    act(() => {
      fireEvent(window, new Event('focus'))
    })
    expect(result.current).toBe(0)
  })

  it('stops ticking after unmount', () => {
    const { result, unmount } = renderHook(() => useLiveTick(60_000))
    unmount()
    act(() => vi.advanceTimersByTime(120_000))
    expect(result.current).toBe(0)
  })
})

/**
 * The default is a database budget decision, not a taste one. At one minute a
 * single dashboard left open for a working day refetched ten thousand times a
 * month and held the database awake 176 hours, which was most of the compute
 * the whole system is allowed. Coming back to a tab still refreshes it at
 * once, so the interval is only ever felt on an unattended screen.
 */
describe('the default interval', () => {
  it('is five minutes, because a shorter one costs more than it is worth', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useLiveTick())

    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current).toBe(0)

    act(() => vi.advanceTimersByTime(240_000))
    expect(result.current).toBe(1)
    vi.useRealTimers()
  })
})
