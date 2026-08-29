'use client'

import { useEffect, useState } from 'react'

/**
 * A counter that bumps when the tab regains focus or becomes visible again,
 * and every `everyMs` while it stays visible. Put it in a fetch effect's
 * dependencies and an open tab keeps itself current instead of showing the
 * world as of whenever it was loaded.
 *
 * A hidden tab never ticks - background tabs do no work. Focus and
 * visibilitychange often fire together, so bumps within a second collapse
 * into one: one tick, one refetch.
 *
 * Five minutes, not one. The interval is only a backstop: coming back to a tab
 * fires focus and refetches immediately, so the gap is only ever felt by
 * someone staring at an unattended screen. A minute cost far more than it was
 * worth - one dashboard left open for a working day held the database awake
 * 176 hours a month and refetched ten thousand times, which on its own was
 * nearly half the compute budget the whole system gets.
 */
export function useLiveTick(everyMs = 300_000): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    // The mount itself already fetched, so the clock starts now - a focus
    // event that races the first render must not cause a duplicate fetch.
    let last = Date.now()

    const bump = () => {
      if (document.hidden || Date.now() - last < 1000) return
      last = Date.now()
      setTick((t) => t + 1)
    }

    window.addEventListener('focus', bump)
    document.addEventListener('visibilitychange', bump)
    const id = setInterval(bump, everyMs)
    return () => {
      window.removeEventListener('focus', bump)
      document.removeEventListener('visibilitychange', bump)
      clearInterval(id)
    }
  }, [everyMs])

  return tick
}
