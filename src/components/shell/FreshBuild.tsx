'use client'

import { useEffect, useRef } from 'react'
import { useLiveTick } from '@/lib/use-live-tick'

/** Inlined at build time, so every tab knows which deployment it came from. */
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'

/**
 * Deploys must reach tabs that are already open. Once a minute (and on focus)
 * this asks the server which build it is running; the moment the answer
 * differs from the build this tab was loaded from, the tab reloads itself.
 * Without it, a parked tab keeps running week-old code forever — fresh data
 * wearing an outdated page.
 */
export function FreshBuild({
  onNewBuild,
}: {
  /** Test seam. Real usage reloads the window. */
  onNewBuild?: () => void
}) {
  const tick = useLiveTick()
  const reloading = useRef(false)

  useEffect(() => {
    if (tick === 0) return // the page just loaded; it IS the current build
    let stale = false
    fetch('/api/version')
      .then((res) => res.json())
      .then(({ id }: { id?: string }) => {
        if (stale || reloading.current || !id || id === BUILD_ID) return
        reloading.current = true
        if (onNewBuild) onNewBuild()
        else window.location.reload()
      })
      .catch(() => {}) // offline or flaky — next tick will ask again
    return () => {
      stale = true
    }
  }, [tick, onNewBuild])

  return null
}
