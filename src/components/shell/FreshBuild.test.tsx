// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { FreshBuild } from './FreshBuild'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const version = (id: string) =>
  Promise.resolve(new Response(JSON.stringify({ id }), { status: 200 }))

/**
 * One tick of the shared live clock. Named rather than written as a number in
 * six places, so changing the interval for the database's sake cannot silently
 * turn these into tests that advance past nothing.
 */
const ONE_TICK = 300_000

describe('FreshBuild', () => {
  it('does nothing at mount, and stays quiet while the server runs this same build', async () => {
    const fetchMock = vi.fn(() => version('dev')) // BUILD_ID is 'dev' outside a real build
    vi.stubGlobal('fetch', fetchMock)
    const onNewBuild = vi.fn()
    render(<FreshBuild onNewBuild={onNewBuild} />)
    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled() // the page just loaded - it IS current

    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onNewBuild).not.toHaveBeenCalled()
  })

  it('reloads exactly once when the server starts answering with a different build', async () => {
    vi.stubGlobal('fetch', vi.fn(() => version('a-new-deploy')))
    const onNewBuild = vi.fn()
    render(<FreshBuild onNewBuild={onNewBuild} />)

    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK)
    })
    expect(onNewBuild).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK * 2)
    })
    expect(onNewBuild).toHaveBeenCalledTimes(1) // the reload is already underway
  })

  it('shrugs off a failed or nonsense check and simply asks again next tick', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockImplementation(() => version('later-deploy'))
    vi.stubGlobal('fetch', fetchMock)
    const onNewBuild = vi.fn()
    render(<FreshBuild onNewBuild={onNewBuild} />)

    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK) // network down - swallowed
    })
    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK) // no id in the answer - ignored
    })
    expect(onNewBuild).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(ONE_TICK) // a real new build - now it acts
    })
    expect(onNewBuild).toHaveBeenCalledTimes(1)
  })
})
