'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Toaster } from './Toaster'
import { ToastContext, type Toast, type ToastTone } from './useToast'

/** A success is a glance. An error carries the server's own wording and needs reading. */
const DURATION: Record<ToastTone, number> = { success: 4000, error: 10000 }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, text: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, tone, text }])
      timers.current.set(id, setTimeout(() => dismiss(id), DURATION[tone]))
    },
    [dismiss],
  )

  // A timer firing after unmount is a state update on a dead component.
  // Copy the map into the effect body: a cleanup must not read `.current`,
  // which may have moved on by the time it runs.
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach(clearTimeout)
      map.clear()
    }
  }, [])

  const api = useMemo(
    () => ({
      success: (text: string) => push('success', text),
      error: (text: string) => push('error', text),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}
