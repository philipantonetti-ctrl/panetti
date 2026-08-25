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
 */
export function useLiveTick(everyMs = 60_000): number {
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
