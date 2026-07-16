'use client'

import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error'
export type Toast = { id: number; tone: ToastTone; text: string }

export type ToastApi = {
  success: (text: string) => void
  error: (text: string) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

/** The only way to raise a toast. Throws rather than silently swallowing. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside a ToastProvider')
  return api
}
